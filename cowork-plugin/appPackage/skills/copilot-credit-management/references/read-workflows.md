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
Assigned groups are available through the separate read below, not inferred
from omitted policy fields. No write tools are available.

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
explicit errors. UserData alone does not authorize the roster reads below.

## Basic user profiles

Call `get_user_basic_profile` with a supplied or discovered Entra user GUID as
required `userId`. It reads basic profile fields using delegated
`User.ReadBasic.All`; the group-membership permission alone may return only
member GUIDs and null properties. Selecting fields does not grant access.

The result's `data` contains only the returned id, displayName and
userPrincipalName. `nameResolutionStatus` is complete when both name fields are
nonblank, partial when only one is available, and unavailable when neither is.
Missing, null and empty fields remain distinct in the returned data. Show the
GUID and an explicit unavailable status rather than guessing a name or email.
The UPN is a sign-in name and need not be the user's email address.

Profiles are not paged. A mismatched response ID, invalid response, inaccessible
profile, deleted user or missing consent is an error. This read does not
substitute the caller for the target user or broaden group/balance permissions.
Use the returned observation time; it is not an atomic roster snapshot.

## Policy user table

For "Erstelle eine Tabelle aller User in Cowork Large, inkl. aktuellem Stand":

1. Page `list_spending_policies` completely to resolve the actual requested
   policy by its returned name and ID. If multiple policies match, clarify the
   target; never guess an ID or treat the name as an identifier. Keep limits
   separate from actual user balances.
2. Call `list_policy_assigned_groups` with that exact `policyId`. Follow every
   returned `@odata.nextLink` unchanged for the same policy. The type-cast route
   applies to selected-groups policies, not all policy types. A failure or
   unsupported policy type is not evidence of no assignments.
3. For each distinct assigned group GUID, page `list_group_users` sequentially.
   Use `transitive: true` by default for all nested user members, or false when
   the user explicitly asks for direct members. Keep mode and group fixed
   while following each next link. This is a directory-membership roster:
   nested membership does not establish effective policy targeting, precedence
   among multiple policies or enforcement. Membership uses an eventual index
   and may lag recent changes.
4. Deduplicate users by returned GUID case-insensitively across pages and groups
   while retaining all their source group IDs/names. If displayName or
   userPrincipalName is missing, null or blank, call `get_user_basic_profile`
   once per distinct user after deduplication, sequentially. Skip profile lookup
   when both fields are already available. Fill only missing fields, preserve
   existing fields and source provenance, and disclose any conflicting values.
   If the tool, consent or profile is unavailable, retain the GUID and explicit
   name-resolution status. Do not request a wider directory permission.
   Continue balance reads even if profile resolution fails.
5. For each distinct user, call `list_user_service_balances` sequentially using
   that GUID as `userId`; follow all its pages. Display only actually returned
   `serviceId: cowork` records. Preserve units/periods and explicit zero; use
   separate rows for incompatible periods/units or multiple Cowork records.
   A failed read or absent Cowork record remains unavailable, not zero.
6. Produce a table using fields actually returned: user name/UPN if available,
   user GUID, source groups, service/period/unit, consumed quantity, remaining
   quantity, separate profile/balance statuses and observation times. Omit or mark unavailable fields
   rather than fabricating values. Do not calculate remaining credits from
   purchased minus consumed quantities.
7. State the policy ID, membership mode, number of distinct groups/users read
   and completeness of assignments, membership and balances separately.
   Keep users with balance errors in the table, with safe error codes when
   available. List failed groups separately because their missing users cannot
   be enumerated. Report all pending continuation pages. Detect repeated next
   links and stop with an explicit incomplete result rather than looping.
   For throttling/timeouts, honor Retry-After and do not automatically retry.

This table shows the current returned per-user service data for the directory
roster, not a policy-specific financial statement, effective policy assignment
proof or an atomic snapshot. Server timestamps are observation times; do not
invent a shared service timestamp. An empty successful assigned-group page
after complete paging means no groups were returned, not zero tenant usage.
If the necessary tools are not discovered, explain the missing capability and
updated-plugin requirement; never bypass the connector.

Additional roster prerequisites are delegated
`CopilotCostManagement-Assignment.Read.All` and `GroupMember.ReadBasic.All`
on the MCP app, in addition to UserData for balances. Signed-in-user directory
roles, tenant eligibility and endpoint availability remain separate. Hidden
membership may require separate authorization; disclose incompleteness and
do not request `Member.Read.Hidden` or a broader permission automatically.
Basic-profile resolution additionally needs `User.ReadBasic.All`; administrator
review may be required by tenant consent policies. Profile failure affects name
completeness, not the known user roster or previously verified balance values.
Do not silently repeat the same profile lookup for each source group or cache
profiles across signed-in callers. If the profile tool is not discovered, the
backend must be updated; a new ZIP alone cannot expose that server capability.

## Suggested user requests

- "Zeige mein Copilot-Credit-Guthaben."
- "Liste alle Copilot-Ausgabenrichtlinien."
- "Erstelle eine Uebersicht aus Guthaben und Ausgabenrichtlinien."
- "Zeige meine Copilot-Serviceguthaben und meinen Cowork-Verbrauch."
- "Erstelle eine Tabelle aller User in Cowork Large, inkl. aktuellem Stand."

These are read requests. A report should state the current caller/tenant
context only when safely supplied by the runtime, not from a preset account.
Do not expose or ask for access tokens to establish that context.
