# Reach card contract

Required: one nonblank unfolded From, Subject, Date, Message-ID, X-Work and X-Type; at least one To/Cc/Bcc destination; nonblank body for send/reply. From has one display name and angle address. Address syntax: `^[a-z][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,63}@[a-z0-9][a-z0-9.-]{0,252}$`.

| Type | Subject tag |
|---|---|
| question | QUESTION |
| decision | DECISION |
| answer | ANSWER |
| info | FYI |
| status | STATUS |
| done | DONE |
| cancel | CANCEL |

The tag is bracketed at the start of Subject, optionally preceded by `Re: `. To is action, Cc informed, Bcc private. Each delivered copy has its own Delivered-To; Bcc is stripped. Info cannot name To. An answer includes the original work's Reply-To destination on To, or its From when Reply-To is absent. Blank/invalid Reply-To is an error.

X-Name carries the initialized display name. X-Tag is a repeatable printable label. X-No-Reply can only be true and is invalid for questions. X-State is accepted/running/requires-action/completed/failed/cancelled/refused. Accepted/running use status; requires-action uses question. Terminal values are written by reply only. Completed/failed require an accepted chain; cancelled/refused do not.

Replies include one In-Reply-To and a References chain of angle-bracket IDs containing that parent. Acceptance references the original work without changing its held copy. Later replies reference the original work and preceding report chain. Received reports may be dismissed without replying or changing the referenced work state.

Supersedes names one Message-ID and cannot coexist with X-State or cancel. Expiry-Date is an RFC5322 date. Auto-Submitted is no/auto-generated/auto-replied. A value other than `no` means the message is saved and delivered but never triggers notification, including on explicit outbox flush. Non-automatic To copies attempt notification once; Cc copies do not notify. Successful delivery returns 0 even if notification fails, and stderr reports the failed notification directly; transport failure remains nonzero and preserves queued bytes for explicit flush. Automatic call/watch events carry auto-generated and cannot produce recursive notification or reply loops. Unknown X-extensions and old X-Journey/X-Callsign headers are refused. `sno reach lint` checks a private snapshot and does not place or rewrite mail.

See the co-shipped [agent guide](../guide/agent-reach.md) for complete command, failure and acknowledgment instructions.
