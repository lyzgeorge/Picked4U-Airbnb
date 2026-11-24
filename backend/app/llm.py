"""One call_llm(system, user) -> text for three protocols, plus defensive JSON parsing."""
import json
import logging
import re
import time

from . import config

log = logging.getLogger("llm")
_client = None


def _get_client():
    global _client
    if _client is None:
        if config.LLM_PROTOCOL == "google_genai":
            from google import genai
            from google.genai import types
            http = types.HttpOptions(base_url=config.LLM_BASE_URL) if config.LLM_BASE_URL else None
            _client = genai.Client(api_key=config.LLM_API_KEY, http_options=http)
        elif config.LLM_PROTOCOL == "anthropic_messages":
            from anthropic import Anthropic
            _client = Anthropic(base_url=config.LLM_BASE_URL, api_key=config.LLM_API_KEY)
        else:
            from openai import OpenAI
            _client = OpenAI(base_url=config.LLM_BASE_URL, api_key=config.LLM_API_KEY)
    return _client


def call_llm(system, user):
    t0 = time.time()
    try:
        return _call(system, user)
    finally:
        log.info("LLM call %.1fs", time.time() - t0)


# LLM_REASONING_EFFORT -> Gemini thinking level ("none" isn't offered; MINIMAL is the lowest)
_GEMINI_LEVEL = {"none": "MINIMAL", "minimal": "MINIMAL", "low": "LOW", "medium": "MEDIUM", "high": "HIGH"}


def _call_google(client, system, user):
    from google.genai import types
    level = _GEMINI_LEVEL.get(config.LLM_REASONING_EFFORT.lower())

    def make(thinking):
        cfg = types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=2048,
            response_mime_type="application/json",  # every prompt in this backend expects JSON
            thinking_config=types.ThinkingConfig(thinking_level=level) if thinking and level else None)
        return client.models.generate_content(model=config.LLM_MODEL, contents=user, config=cfg)

    try:
        resp = make(True)
    except Exception as err:
        if not level or "think" not in str(err).lower():  # only fall back when the thinking setting is the problem
            raise
        log.warning("model rejected thinking level %s; retrying without it", level)
        config.LLM_REASONING_EFFORT = ""
        resp = make(False)
    return resp.text or ""


def _call(system, user):
    client = _get_client()
    if config.LLM_PROTOCOL == "google_genai":
        return _call_google(client, system, user)
    if config.LLM_PROTOCOL == "anthropic_messages":
        msg = client.messages.create(model=config.LLM_MODEL, system=system, max_tokens=1024,
                                     messages=[{"role": "user", "content": user}])
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    kwargs = {"reasoning": {"effort": config.LLM_REASONING_EFFORT}} if config.LLM_REASONING_EFFORT else {}
    try:
        resp = client.responses.create(model=config.LLM_MODEL, instructions=system, input=user, **kwargs)
    except Exception:
        if not kwargs:
            raise
        log.warning("model rejected reasoning effort; retrying without it")
        config.LLM_REASONING_EFFORT = ""
        resp = client.responses.create(model=config.LLM_MODEL, instructions=system, input=user)
    return resp.output_text or ""


def _try_parse(raw):
    """Strip ``` fences and a leading 'json', then parse; fall back to the outermost {...}."""
    cleaned = raw.strip().strip("`").strip()
    if cleaned.lower().startswith("json"):
        cleaned = cleaned[4:].strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        return json.loads(match.group(0)) if match else None


def parse_json(system, user):
    """Call the LLM expecting one JSON object. Retry once with a reminder; return None if both fail."""
    for attempt in range(2):
        prompt = user if attempt == 0 else user + "\n\nReturn valid JSON only: one object, no other text."
        try:
            parsed = _try_parse(call_llm(system, prompt))
            if isinstance(parsed, dict):
                return parsed
        except Exception as err:  # bad JSON or API error
            log.warning("LLM/JSON problem on attempt %d: %s", attempt + 1, err)
    return None
