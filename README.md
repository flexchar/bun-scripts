> **ARCHIVED - unmaintained as of 2026-08-25.**
>
> The Danish VAT script (`skat/`) moved to `projects/emv-office/skat/` in the LVC-Hustle workspace. That version reads the Bogholder sheet through the authenticated `gws` CLI instead of a publish-to-web CSV, and carries two calculation bugfixes that were never applied here. Do not run `skat/` from this repo.
>
> `ocr/` is retired along with it.

# bun-scripts

My collection of scripts to do what-ever. You're welcome to look and use it freely, but not to claim ownership and sell.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.1.10. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
