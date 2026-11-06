---
name: kerf-ui
description: Build Kerf interfaces with the @kerfjs/ui component package.
kerf-skill-version: 1.0.0
---

# Building with @kerfjs/ui

Before changing a consuming interface, resolve these files from the selected
package (which may live inside a workspace) and read them in order:

1. `node_modules/@kerfjs/ui/llms.txt` for the retrieval order and package overview.
2. `node_modules/@kerfjs/ui/ai/skill.md` for the UI rules and component selection process.
3. The component references and contracts named by those files for each component you use.

Use the installed package's guidance so its instructions match the UI version in this project. Follow the project's own UI conventions and run its `kerf:check` after a change.

<!-- KERF-APP-CANONICAL-END · your customizations below -->
