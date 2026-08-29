# Contributing

Contributions should preserve the repository's public-safe boundary:

1. Use only synthetic data and reserved example identifiers.
2. Do not submit logs, credentials, internal hostnames, customer names, private
   policies, evidence, detection signatures, or deployment details.
3. Keep the demo GET-only and free of outbound network requests.
4. Add or update tests for every route or renderer change.
5. Run `npm test` and `npm run audit:public` before opening a pull request.

Open an issue before proposing operational integrations. They are outside the
scope of this scaffold.
