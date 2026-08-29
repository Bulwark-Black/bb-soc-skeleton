# Architecture

## Purpose

The scaffold demonstrates a console's presentation boundary. It is intentionally
small enough to read in one sitting and intentionally incapable of monitoring an
environment.

```text
public/index.html
  |
  +-- public/app.css   presentation tokens and responsive layouts
  +-- public/app.js    fixed route catalog, synthetic fixtures, DOM rendering
```

There is no database, queue, scheduler, collector, webhook, email client,
infrastructure client, credential loader, or background job.

## Safety properties

- There is no application server or API.
- Fixed synthetic values are assigned with DOM text properties.
- A restrictive Content Security Policy is declared in the document.
- Demo controls are disabled or intercepted in the browser and never reach a
  mutation endpoint.
- Fixtures are frozen and use generic example labels.

These properties make the boundary easy to inspect; they do not make this a
production security product.

## Adding a page

1. Add route metadata to the fixed catalog in `public/app.js`.
2. Select an existing component or add a generic DOM renderer.
3. Add synthetic fixture data only if the page needs it.
4. Extend the route test and run the public-content audit.

## Turning a concept into a real system

Build operational capabilities in a separate private implementation. Define a
threat model and trust boundaries first, then design authenticated adapters that
produce a narrow presentation model. Do not place production credentials,
telemetry, evidence, or estate configuration in this repository.
