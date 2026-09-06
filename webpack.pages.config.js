const fs = require("fs");
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const root = __dirname;
const templatePath = path.join(root, "demo", "index.html");

function getTemplate() {
  return fs.readFileSync(templatePath, "utf8")
    .replace(/<script\s+src="(?:\.\.\/)?src\/piano-synth\.js"><\/script>\s*/i, "")
    .replace(/<script\s+src="(?:\.\.\/)?model\/piano_nn_bin\.js"><\/script>\s*/i, "")
    .replace(/PianoSynth\.load\([^)]*\)/g, "PianoSynth.load()");
}

module.exports = {
  mode: "production",
  target: "web",
  entry: path.join(root, "scripts", "pages-entry.js"),
  output: {
    path: path.resolve(process.env.PAGES_SITE_DIR || path.join(root, "site")),
    filename: "piano-synth-pages.[contenthash:8].js",
    clean: true
  },
  optimization: {
    minimize: true
  },
  plugins: [
    new HtmlWebpackPlugin({
      filename: "index.html",
      templateContent: getTemplate(),
      inject: "head",
      scriptLoading: "blocking",
      minify: {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        useShortDoctype: true,
        minifyCSS: true,
        minifyJS: true
      }
    })
  ]
};
