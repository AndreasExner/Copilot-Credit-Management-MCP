# Read workflows

## Balance

Call `get_tenant_credit_balance` without arguments. The result has the server's
structured response wrapper, including `data` for the Graph response. Inspect
the actual data rather than assuming a fabricated fixed row layout.

List the returned balance records and clearly identify their returned billing
method, period or other discriminators where present. Show remaining credits
only from `remainingQuantity` when that field exists. Preserve explicit zero;
represent omitted or null quantities as unavailable, not zero. Do not calculate
an alternative remaining amount or combine incompatible units or periods.

## Spending policies

Call `list_spending_policies` without `nextLink` initially. Inspect the policy
collection and `@odata.nextLink` in the actual returned Graph data. Use
`nextLink` only with that exact service-returned value.

For a full inventory, read subsequent pages sequentially. Do not change,
decode/re-encode, shorten, manufacture or add `$top` to continuation URLs.
If a page fails, retain the verified earlier rows and explicitly mark the
inventory incomplete. An empty successfully returned collection is different
from an unavailable or failed response.

Summarize each policy using fields that actually exist, such as its returned
identifier, display name, status, period, limits or assignments. A field's
absence does not prove an unlimited budget, an unassigned policy or zero usage.
No other policy-read or write tools are available in this evaluation release.

## User service balances

Call `list_user_service_balances` without arguments for the signed-in user's
own data. The server uses the validated caller's Entra object GUID, not a preset
administrator. For another authorized user, pass `userId` as their Entra object
GUID. Do not pass an email address, name, guessed identifier or tenant ID.

Read the actual `data` payload and its collection. Keep service identifiers,
returned quantities, units and periods distinct. Do not invent response fields
or equate consumption with remaining balance. Display quantities only when
actually supplied by the service, preserving zero versus absence.

For a Cowork-only view, select actual returned `serviceId: cowork` records for
display after each page. Do not add an undocumented server-side query. If none
are returned, state that no matching record was returned, not zero usage.

Follow any `@odata.nextLink` in the returned `data` unchanged using `nextLink` with the same
`userId` (or keep it omitted for the caller). Never switch users between pages.
Mark partial results incomplete if paging fails.

The endpoint example names the delegated `CopilotCostManagement-UserData.Read.All`
scope. The previously approved two tenant/policy read scopes do not imply this
additional consent. Consent errors, roles and endpoint availability must remain
explicit errors. No group enumeration or directory lookup is implemented.

## Suggested user requests

- "Zeige mein Copilot-Credit-Guthaben."
- "Liste alle Copilot-Ausgabenrichtlinien."
- "Erstelle eine Uebersicht aus Guthaben und Ausgabenrichtlinien."
- "Zeige meine Copilot-Serviceguthaben und meinen Cowork-Verbrauch."

These are read requests. A report should state the current caller/tenant
context only when safely supplied by the runtime, not from a preset account.
Do not expose or ask for access tokens to establish that context.
