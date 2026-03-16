await Bun.build({
  entrypoints: ['./src/ui/CodexPlugin.tsx'],
  outdir: './dist',
  naming: 'CodexPlugin.js',
  format: 'esm',
  minify: true,
});
console.log("UI Bundle built at dist/CodexPlugin.js");
