const fs = require("fs");
const path = require("path");
const { minify } = require("terser");

const root = path.join(__dirname, "..");
const site = path.resolve(process.env.PAGES_SITE_DIR || path.join(root, "site"));
const demo = fs.readFileSync(path.join(root, "demo", "index.html"), "utf8");
const embedded = fs.readFileSync(path.join(root, "dist", "piano-synth-embedded.min.js"), "utf8");

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtml(html) {
  return html
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function build() {
  const styleMatch = demo.match(/<style>([\s\S]*?)<\/style>/i);
  const scriptMatches = [...demo.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  if (!styleMatch || scriptMatches.length !== 1) {
    throw new Error("Expected one inline style and one inline script in demo/index.html");
  }

    const inlineScript = `(() => {
  ${scriptMatches[0][1].replace(/PianoSynth\.load\([^)]*\)/, "PianoSynth.load()")}
  })();`;
  const minifiedScript = (await minify(inlineScript, {
    compress: true,
    mangle: true,
    format: { comments: false }
  })).code;

  let output = demo
    .replace(/<script\s+src="\.\.\/src\/piano-synth\.js"><\/script>\s*/i, `<script>${embedded}</script>`)
    .replace(/<script\s+src="\.\.\/model\/piano_nn_bin\.js"><\/script>\s*/i, "")
    .replace(/<script\s+src="src\/piano-synth\.js"><\/script>\s*/i, `<script>${embedded}</script>`)
    .replace(/<script\s+src="model\/piano_nn\.bin"><\/script>\s*/i, "")
    .replace(/PianoSynth\.load\("model\/piano_nn\.bin"\)/g, "PianoSynth.load()")
    .replace(styleMatch[0], `<style>${minifyCss(styleMatch[1])}</style>`)
    .replace(`<script>${scriptMatches[0][1]}</script>`, `<script>${minifiedScript}</script>`);

  fs.rmSync(site, { recursive: true, force: true });
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), minifyHtml(output));
  console.log("built site/index.html");
}

build().catch(error => {
  console.error(error);
  process.exit(1);
});
