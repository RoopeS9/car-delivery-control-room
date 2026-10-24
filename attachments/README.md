# Fictional case attachments

This folder contains an original, generated PDF for each filed signed CMR or verified release authority in the snapshot, selected fictional expense receipts, plus generated case photos. Every person, company, site, street address, plate, vehicle reference, merchant, and case detail in them belongs to the synthetic challenge world. City names and car makes and models may be real. These files are not copies of production material or valid transport or tax documents.

`manifest.json` is the join table. Each entry names an order and the exact document, proof, message, site visit, or expense record in `../dataset/data/`. It also gives the file path, content type, status, and SHA-256 hash. The starter loads the files into its local object store and exposes read-only links through the order attachment API.

The photos and expense receipts are **selected sample files**, not a complete export of every file mentioned in the JSONL records. For example, a proof can state `file_count: 4` while this packet includes only one of its photos. An expense with `receipt_state: ATTACHED_NOT_SAMPLED` claims a receipt, but its bytes are not supplied here. `ATTACHED_SAMPLED` means at least one inspectable fictional receipt is linked in the manifest. A document marked `MISSING` has no PDF here. Do not infer that a missing sample photo means the underlying proof has no file, or that a submitted file proves a signature, a cause of damage, or a site-confirmed fact.

The selected files include handover, condition, site-visit and expense records.
Their captions and manifest links tell you who submitted a file and which
record owns it. Compare that record with earlier evidence and later decisions
before treating the file as proof of an outcome. The sampled expense PDFs span
cost kinds and review states, including one corrected-claim pair on CD-420326
that shares identical receipt bytes. A receipt documents a fictional cost, not
an approval or payout.

Most `CMR` records marked `SIGNED` refer to a pickup-side transport document
and do not prove receiver acknowledgement. The generator can also file a paper
CMR with `medium: PAPER` and an explicit `signature_scope` of `SELLER_ONLY` or
`BOTH`. None is in this packet. The signed CMRs here are digital and carry
`signature_scope: COLLECTION_ONLY`. Pickup and delivery proof captures are
separate records. Check that scope and the delivery evidence before treating a
CMR as a complete handover.

CD-420455 includes one pickup and one delivery view of the same fictional car
beside its verified release authority PDF. The different lighting and limited
angle do not settle the later condition claim on that order. The complete photo
sets (four pickup files and three delivery files) are not supplied.

The PDFs and photos are original fictional samples. The generated image pixels
are illustrative; do not rely on them for exact text, identity, VIN, plate,
odometer or signatures.

Run `python3 check_packet.py` from the packet folder to verify attachment
hashes and record links along with the rest of the dataset.
