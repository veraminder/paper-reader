// Loads the browser backend, then hands over to app.js (which waits for the
// "backendready" event, the way the Mac app waits for pywebview).
import("./api.js")
  .then(({ backend }) => {
    window.backend = backend;
    window.dispatchEvent(new Event("backendready"));
  })
  .catch((err) => {
    console.error(err);
    const message = document.getElementById("empty-error");
    message.textContent = "Paper Reader couldn't load its components. Check your internet connection and reload the page.";
    message.hidden = false;
  });
