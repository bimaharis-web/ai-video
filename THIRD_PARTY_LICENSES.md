# Third-party licenses

## MoneyPrinterTurbo

- Project: [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo)
- Copyright: Copyright (c) 2024 Harry
- License: MIT
- The upstream license text is included in [`LICENSE`](./LICENSE).
- This application calls the separately installed upstream API. It does not
  vendor its source code.

## Runtime and media dependencies

The local application server uses Node.js built-in modules and declares no
third-party npm runtime packages. The separately installed video engine may
use Python packages, FFmpeg, fonts, media codecs, and other dependencies. Their
licenses and notices are controlled by the engine's exact installed versions
and build options; consult that installation's license files. In particular,
FFmpeg codec and distribution terms can vary by build configuration.

## AI providers and media sources

Provider services, models, stock footage, and music have separate terms,
licenses, quotas, and pricing. Review those terms before use; an API being
available or a free tier existing does not grant unrestricted rights or
guarantee ongoing free usage.
