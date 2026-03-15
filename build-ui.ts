await Bun.build({
  entrypoints: ['./src/ui/CodexPlugin.tsx'],
  outdir: './dist',
  minify: true,
  format: "esm",
  external: ['react', 'react-dom'] // The Cockpit will provide React
});
console.log("UI bundled successfully.");
