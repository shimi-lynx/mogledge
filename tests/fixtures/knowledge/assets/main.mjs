import { describe } from "./helper.mjs";
const data = await fetch("./" + "../assets/data.json").then((response) => response.json());
document.querySelector("#module-result").textContent = describe(data);
document.querySelector("#range").addEventListener("input", (event) => {
  document.querySelector("#value").value = event.target.value;
});
document.querySelector("#action").addEventListener("click", () => {
  const context = document.querySelector("#canvas").getContext("2d");
  context.fillStyle = "#338866";
  context.fillRect(0, 0, 100, 100);
  document.documentElement.dataset.canvas = "drawn";
});
await import("./probe.mjs");
