# Routine driver questions

## When it applies

A driver asks something the records can answer: the pickup or delivery
address and hours, the contact name, what papers to bring or collect, the
ferry booking reference and check-in time, which train is booked, how to
submit a receipt.

## How to answer

1. Read the order (`get_order_context`) and, if needed, the timeline.
2. Answer in one or two sentences, quoting the record and its source.
3. If the record is unconfirmed or missing, say so plainly and ask the site
   (when it is not the customer) or hand over.
4. When the driver has what they need, close the case (`close_case`) with a
   one-line summary. It shows in the control room as handled by the agent.

## Common answers

- **Ferry**: give the booking reference, the terminal and the check-in cutoff
  in local time. If only a quote exists, say there is no booking yet and hand
  over.
- **Papers**: say what the site's release rule needs, e.g. a signed release
  or the plate documents, from the site profile.
- **Keys**: see the keys and access playbook.
- **Costs**: see the expenses playbook.

## Never

Never guess. If the records do not say, the answer is "I don't have that in
the records; I've asked …" or a handover.
