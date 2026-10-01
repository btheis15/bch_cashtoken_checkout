# Zero-conf and double-spend proofs

Bitcoin Cash payments are normally accepted at **zero confirmations**: the
moment the transaction reaches the network, not after a block. This kit does
that safely, following the BCH network's own specs.

## Why it's safe enough for a shop

- **First-seen, no replace-by-fee.**
  - BCH nodes reject a transaction that spends the same coins as one already
    in their mempool: "Transactions that double spend inputs of another
    transaction already in the mempool will be rejected"
    ([documentation.cash, memory pool](https://documentation.cash/protocol/blockchain/memory-pool)).
  - Opt-in replace-by-fee (BIP125) "has been removed in v0.14.1"
    ([BCHN BIPs](https://docs.bitcoincashnode.org/doc/bips/)).
- **Double-spend proofs (DSProofs).**
  - When someone tries to spend the same coins twice, nodes relay a proof of
    it. That way "the merchant will see it in less than 3 seconds"
    ([Tom Zander](https://read.cash/@TomZ/making-regular-payments-more-secure-with-dsproof-927f42d9)).
  - The [DSProof spec](https://upgradespecs.bitcoincashnode.org/dsproof/):
    "The ability to get informed of such an event can assist greatly in the
    confident acceptance of unconfirmed transactions."
  - BCHN has had them "enabled by default" since
    [23.0.0](https://docs.bitcoincashnode.org/doc/release-notes/release-notes-23.0.0/)
    (2021), compatible with Bitcoin Unlimited and Flowee.
  - They are a relay feature, not a consensus rule.

## What the checkout does

1. **Enough arrives.** The address's history (`blockchain.scripthash.get_history`)
   shows the payment at height 0, or -1 if its own parents are unconfirmed. The
   shopper's screen says "Payment received" at once.
2. **It listens `proofWaitMs` (3 seconds) for a proof.** This is the spec's
   merchant step: "wait T seconds… for a proof to arrive. If a
   double-spend-proof corresponding to the paying transaction or any of its
   ancestors arrive, the merchant shall either decline the payment, or wait for
   confirmation."
3. **It asks.** It calls `blockchain.transaction.dsproof.get(<payment txid>)`.
   The [Electrum Cash protocol](https://electrum-cash-protocol.readthedocs.io/en/latest/protocol-methods.html)
   (1.4.5+, Fulcrum 1.5+) answers with the proof "If the transaction in
   question has an associated dsproof… Otherwise null". Fulcrum also maps
   descendants, so a proof against a mempool ancestor of the payment is found
   too.
   - **No proof:** the payment counts and `onPaid` runs. The shopper sees the
     thank-you page about 3 seconds after paying.
   - **A proof:** the payment is held (`state: "checking"`, with a "dropped"
     problem) until a block settles which transaction counts.
4. **It keeps watching until the first block**, every minute in `tick()` and
   whenever the address changes:
   - If a proof turns up later, or the payment vanishes from the mempool, the
     payment gets a "dropped" problem so the merchant doesn't ship.
   - A vanished payment isn't always fraud: a low-fee transaction can be
     evicted.

## Servers

The connection prefers Fulcrum servers whose `server.features` says
`dsproof: true`. "If this key is missing or false, then the server does not
support dsproofs." A server without proofs is only used as a last resort, and
then a proof check counts as **unknown**, never as clean. When that happens the
payment is still accepted (zero-conf), with a note, and watched until its
block. All five default servers ran Fulcrum 2.1.x with DSProofs when this was
written (2026-10).

## What proofs don't cover

The spec protects "Transactions that spend all, confirmed, P2PKH outputs with
all inputs signed SIGHASH_ALL without ANYONECANPAY." `readPayment()` checks
each input:

- **Covered:** a P2PKH spend, meaning two pushes (a signature and a public key),
  signed with ALL|FORKID and without ANYONECANPAY.
  - The 2023 SIGHASH_UTXOS bit is allowed. Whether every node's DSProof code
    handles it is unverified.
- **Anything else** (script and multisig wallets, CashScript contracts): the
  payment is accepted at once, but gets an "unprotected" problem ("wait for a
  block before shipping"). That problem clears itself when the block comes.

Ordinary consumer wallets (Selene, Paytaca, Cashonize, Electron Cash standard
wallets) pay from P2PKH addresses.

## Choosing your own policy

- `proofWaitMs`: 3000 by default. The ZCE CHIP describes processors
  "listening for conflicting transactions on the network for 5 to 10 seconds";
  set 5000–10000 for that.
- For very large orders, you can wait for a confirmation before shipping (as
  Prompt.cash and BitPay let merchants do). Physical goods ship days later
  anyway, by which time a block has confirmed the payment; the order's
  `confirmations` tells you.

## Sources

- DSProof spec (Tom Zander, imaginary_username; 2020-09-20): https://upgradespecs.bitcoincashnode.org/dsproof/
- The DSProof P2P message: https://documentation.cash/protocol/network/messages/dsproof-beta
- BCHN 23.0.0 release notes: https://docs.bitcoincashnode.org/doc/release-notes/release-notes-23.0.0/
- BCHN DSProof implementation notes: https://docs.bitcoincashnode.org/doc/dsproof-implementation-notes/
- Electrum Cash protocol methods (dsproof.get / list / subscribe, get_history heights): https://electrum-cash-protocol.readthedocs.io/en/latest/protocol-methods.html
- Zero-Confirmation Escrows CHIP (first-seen, listening windows): https://github.com/bitjson/bch-zce
- Software Verde on DSProof coverage and user guidance: https://bitcoincashresearch.org/t/double-spend-proofs-protocol-improvements-and-providing-end-user-guidance/395
