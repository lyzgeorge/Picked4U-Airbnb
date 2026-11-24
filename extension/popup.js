const PRESETS = [
  "I'm a light sleeper travelling for work. I want a quiet place where I can sleep well, with fast wifi and a good desk, and easy public transport into the city centre. Please nothing noisy.",
  "A weekend in Dublin with friends. We want to be right in the middle of the nightlife, walking distance to pubs, bars and restaurants. A lively area is a plus.",
  "Travelling with two young children. The place must be spotlessly clean and spacious, with a proper kitchen, on a safe quiet street near parks, and with a host who replies quickly.",
];
const $ = (id) => document.getElementById(id);
const FIELDS = ["preference", "backendUrl", "apiToken"];
let timer;

function flash() {
  $("saved").textContent = "Saved";
  clearTimeout(timer);
  timer = setTimeout(() => ($("saved").textContent = ""), 1200);
}

chrome.storage.local.get(["enabled", ...FIELDS]).then((s) => {
  $("enabled").checked = s.enabled !== false;
  for (const f of FIELDS) $(f).value = s[f] || "";
  if (!s.backendUrl || !s.apiToken) $("conn").open = true;
});

$("enabled").addEventListener("change", () => chrome.storage.local.set({ enabled: $("enabled").checked }).then(flash));
for (const f of FIELDS) {
  // debounced so the page doesn't refresh on every keystroke (and still saves if the popup closes soon after)
  let t;
  $(f).addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => chrome.storage.local.set({ [f]: $(f).value.trim() }).then(flash), 700);
  });
}
document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    $("preference").value = PRESETS[+b.dataset.p];
    chrome.storage.local.set({ preference: PRESETS[+b.dataset.p] }).then(flash);
  })
);
