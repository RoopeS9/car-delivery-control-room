# Breakdown

## When it applies

The car will not start, has stopped by itself, has a flat or damaged tyre, a
broken windscreen, or cannot be driven for another physical reason. If there
was a collision, use the accident playbook instead.

## Facts to collect, in order

1. **Is the driver safe?** Off the road, behind the barrier, hazard lights
   on, warning triangle out if it is safe to place it.
2. **Exact location** and whether the car blocks traffic.
3. **What happened**, in the driver's words, and any warning lights or codes
   (`get_active_codes`).
4. **Photos** of the problem, if safe to take.
5. **The order**: owner, delivery promise and source, later bookings.
6. **Nearby help** (`find_nearby_help`): the brand's workshops and tow
   services near the car. These are suggestions, not bookings.

## What you may do alone

Safety instructions, questions, photo requests and lookups.

## When to stop and hand over

When the driver is safe and you know where the car is and roughly what is
wrong. A car blocking a live lane is urgent: hand over at once, with the
safety instruction already given.

## Who decides

Recovery is the car owner's decision through an operator
(`CONTACT_CUSTOMER`, then `BOOK_RECOVERY`). A new delivery date is agreed
with the customer (`CHANGE_PROMISE`). Driver hotel or travel home is a cost
decision (`BOOK_TRAVEL`).

## Never

Never ask the driver to repair the car, change a wheel on a motorway, or
push the car. Never book recovery or travel yourself.

## Worked example

Driver: "The car died on the A7, I'm on the hard shoulder." Safety
instruction: hazard lights on, everyone behind the barrier, do not stand
between the car and traffic. Location: A7 northbound, near a named exit.
Proposal: *Ask the dealer how they want the car recovered* with nearby
brand workshop and tow options listed as quotes.
