# Privacy Policy

Effective date: August 25, 2026

This policy describes how the GLB Label Editor plugin (the "Plugin") handles data.

## Data the Plugin processes

The Plugin processes files and content that you choose to provide, including GLB models, label specifications, label copy, images, fonts, editable label projects, previews, and exported assets. It may also read and write files at paths you explicitly provide to its tools or command-line interface.

## Local processing

The current Plugin runtime operates on your computer. Its visual editor is served from a token-protected loopback address on `127.0.0.1`; model data and generated artifacts move between the Plugin process and that local editor session. The publisher does not operate a remote service that receives this content, and the Plugin does not include publisher telemetry, advertising, or third-party analytics.

Installing the Plugin may contact GitHub, npm package infrastructure, and Playwright's browser-download infrastructure to obtain the source package, locked dependencies, and Chromium. Data handled by Codex, OpenAI, GitHub, npm, Playwright, your operating system, or another service is governed by that service's own terms and privacy policy.

## Storage and retention

Input and output files remain in locations controlled by you. Temporary editor-session data is held in memory while the local session is running. Installed runtime files remain on your computer until you update or remove them. Because the publisher does not receive or store your Plugin content on a publisher-operated server, there is no publisher-hosted account or remote content store to delete.

## Security

The local editor uses an unguessable session token and binds to the loopback interface. Do not share tokenized editor URLs. You are responsible for permissions on the files and directories you provide to the Plugin and for reviewing generated output before using or distributing it.

## Changes and contact

Material changes will be published in this repository. For privacy questions, open a private-safe request using the contact guidance in [SUPPORT.md](SUPPORT.md). Do not post confidential models, tokens, customer data, or proprietary assets in a public issue.
