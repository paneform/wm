import { createLayoutSimulator } from "./playground.js";

const container = document.getElementById("app");
if (container === null) throw new Error("#app container missing");

void createLayoutSimulator(container).catch((error) => {
  console.error("layout playground failed", error);
  const fallback = document.createElement("pre");
  fallback.className = "fatal";
  fallback.textContent = `layout playground failed:\n${String(error)}`;
  container.append(fallback);
});
