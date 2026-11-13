// The screen's number (Settings → Screens the pet lives on → Identify).
const el = document.getElementById("n");
if (el) el.textContent = decodeURIComponent(location.hash.slice(1));
