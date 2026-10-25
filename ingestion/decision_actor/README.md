# FIA Decision Reader

Downloads official FIA decision PDFs already found by `fia-document-monitor` and records what the text says: car numbers, the offence line, a recognized outcome, and a short quote.

A field stays empty when the PDF does not contain it. Nothing here creates a journal entry. Every stored row waits for human review.

## Input

Listing items from a document-monitor dataset or a saved capture, plus an optional document number and a max PDF count.

## Output

One dataset item per PDF that yielded text. `pdf_sha256` matches the bytes downloaded. `PDF_SHA256` in the key-value store maps each official URL to that hash. `RUN_SUMMARY` lists anything skipped and why.
