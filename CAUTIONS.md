# Cautions and Operational Notes

## Scope

- This project is intended for personal use.
- It is not production-hardened and not designed for multi-user deployment.

## Auth and Access

- The extension does not talk directly to OpenAI endpoints.
- It calls a local bridge (`127.0.0.1:8787`) which invokes local `codex exec`.
- If `codex login` expires or changes state, translation will fail until re-authenticated.

## Privacy

- Text selected for translation is sent to the model through your local Codex session.
- Avoid translating confidential, regulated, or highly sensitive data unless you fully accept that risk.

## Reliability

- Large pages can take time; use smaller `Batch Size` and `Max Blocks Per Page` for faster first results.
- Model output can be inconsistent on formatting-heavy pages, code snippets, or mixed-language text.
- Always verify translation quality for legal, medical, financial, or contractual content.

## Local Service Safety

- Keep the bridge bound to localhost (`127.0.0.1`) only.
- Do not expose this bridge to LAN/public networks without adding authentication and request validation.

## Troubleshooting

- Check auth: `codex login status`
- Check bridge health: `GET http://127.0.0.1:8787/health`
- Restart bridge after major config/login changes.
