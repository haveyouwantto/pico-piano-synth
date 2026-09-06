const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
fs.copyFileSync(
  path.join(root, "model", "piano_nn.bin"),
  path.join(root, "dist", "piano_nn.bin")
);
console.log("copied dist/piano_nn.bin");
