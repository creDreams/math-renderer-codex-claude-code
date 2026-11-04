# Third-party software

The Windows companion and the retained Tabby prototype bundle these projects:

| Project | Version | License | Source |
| --- | --- | --- | --- |
| MathJax source | 4.1.3 | Apache-2.0 | https://github.com/mathjax/MathJax-src |
| MathJax NewCM font SVG data | 4.1.3 | Apache-2.0 | https://github.com/mathjax/MathJax-fonts |
| resvg-js (Windows companion only) | 2.6.2 | MPL-2.0 | https://github.com/thx/resvg-js/tree/v2.6.2 |
| Node.js (Windows companion only) | 24.19.0 | MIT and third-party licenses | https://github.com/nodejs/node/tree/v24.19.0 |
| mdast-util-from-markdown and its parser dependencies | 2.0.2 (entry package) | MIT | https://github.com/syntax-tree/mdast-util-from-markdown |
| get-east-asian-width | 1.5.0 | MIT | https://github.com/sindresorhus/get-east-asian-width |
| OpenAI Codex bounded Unicode layout conventions | 616cab3a3529f572c3385098c12698278770ea98 (selected code adapted) | Apache-2.0 | https://github.com/openai/codex |

MathJax is Copyright (c) 2009–2026 The MathJax Consortium. MathJax-NewCM is
part of the MathJax fonts project. Full Apache license text is included in
`dist/licenses/Apache-2.0.txt` in the Tabby package and `licenses/Apache-2.0.txt`
in the Windows package. The font's bundled SVG
path data, including its distributed attribution comments, is preserved by esbuild.

The Windows package includes unmodified resvg-js JavaScript and its upstream
Windows x64 native library. Its full license is in `licenses/MPL-2.0.txt` and
`node_modules/@resvg/resvg-js/LICENSE`. Corresponding source is available at
https://github.com/thx/resvg-js/tree/v2.6.2 (including upstream resvg/Rust
dependencies recorded in Cargo.lock). Agent Math does not modify those files.
Node.js is an unmodified official binary; `NODE_LICENSE.txt` contains its
complete distributed license and third-party notices. Neither is required
as a separate user installation. The Windows host uses the system .NET Framework.

The Markdown parser is bundled for presentation matching. Original copyright
and MIT license notices for its complete dependency tree are preserved in
`licenses/Markdown-MIT.txt` (Windows) and `dist/licenses/Markdown-MIT.txt` (Tabby).

The native display verifier uses get-east-asian-width's Unicode width table for
Chinese, Japanese and Korean text. Its MIT notice is preserved in
`licenses/Unicode-Width-MIT.txt` (Windows) and `dist/licenses/Unicode-Width-MIT.txt`
(Tabby).

The native display verifier adapts Codex's bounded parsing, symbols and structured
layout conventions in TypeScript. The modified implementation identifies the
upstream files; copyright and attribution are preserved in `Codex-NOTICE.txt`
alongside `Apache-2.0.txt` in both packages' license directories.

Tabby, Angular and xterm.js are provided by the host and are not redistributed
in the plugin. Development dependencies and their licenses remain under
`node_modules` and are not included in the plugin tarball. The optional portable
Tabby download is an unmodified upstream release, verified against its GitHub
release asset SHA-256; it remains separate from the plugin package.
