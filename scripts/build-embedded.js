const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const model = fs.readFileSync(path.join(root, "model", "piano_nn_bin.js"), "utf8");
const synth = fs.readFileSync(path.join(root, "dist", "piano-synth.min.js"), "utf8");

fs.writeFileSync(
  path.join(root, "dist", "piano-synth-embedded.min.js"),
  `${model}\n${synth}\n`
);
console.log("built dist/piano-synth-embedded.min.js");
