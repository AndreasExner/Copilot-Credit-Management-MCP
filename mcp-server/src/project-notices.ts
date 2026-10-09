export const projectNotices = {
  about: {
    title: "Copilot Credit Management",
    body: `<p>An internal evaluation project connecting Copilot Cowork to a
protected remote MCP server for Copilot credit balances and spending policies.</p>
<p>This release provides six read-only tools, including policy-assigned groups,
group user membership, targeted basic user profiles and per-user service balance data where authorized and
enabled. Membership reads may lag recent directory changes; a group roster does
not prove policy enforcement or policy-specific consumption. The remaining operations and
mutations are not enabled. Users sign in with their own authorized account;
there is no preset administrator account.</p>
<p>This is a project-operated evaluation service, not a Microsoft-published
application. Microsoft 365, Microsoft Graph and organizational access policies
remain separate prerequisites. Successful installation does not prove
successful delegated Graph access.</p>`,
  },
  privacy: {
    title: "Project privacy notice",
    body: `<p>This factual notice describes the current internal evaluation
service. It is not a replacement for your organization's approved privacy policy.</p>
<p>The MCP server validates the signed-in user's access token and processes
delegated Graph tokens, policy/group/user object identifiers, returned display
names and principal names (including targeted basic-profile reads), tenant/user
service balances and spending-policy responses in memory
to fulfill the requested read. It does not maintain a database of those results.</p>
<p>The application does not intentionally log bearer tokens, client secrets or
customer Graph response bodies. Diagnostic events may contain error/status codes,
correlation IDs and upstream request IDs. Azure platform diagnostics are handled
in the project's Log Analytics workspace, configured for 30-day retention.</p>
<p>Cowork and the Microsoft Enterprise Token Store handle the connector's sign-in
and OAuth credentials. Their data handling, Microsoft service terms and your
organization's policies apply separately. The server does not control Cowork's
retention or the user's workspace.</p>
<p>Contact your organization's administrator or this project's operator for
access, diagnostic-log or data-handling questions. Do not submit credentials
or customer data through these informational pages.</p>`,
  },
  terms: {
    title: "Evaluation usage notice",
    body: `<p>This project is provided for authorized internal evaluation.
It is not a production service commitment, an organization-approved legal
contract or a Microsoft product endorsement.</p>
<p>Use only accounts and data you are authorized to access. Microsoft Graph
permissions, billing roles, Conditional Access and your organization's policies
continue to apply. Administrator consent does not override those requirements.</p>
<p>This release is read-only. It cannot create, update or delete spending
policies, balances or allocations. User confirmation does not enable missing
write tools. Verify returned data and its completeness before making financial
or administrative decisions; missing quantities must not be assumed to be zero.</p>
<p>No production uptime or financial-outcome guarantee is made by this
evaluation notice. The operator must review security, privacy, functionality and
applicable organizational requirements before broader or production deployment.</p>`,
  },
} satisfies Record<string, { title: string; body: string }>;

export function renderProjectNotice(notice: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${notice.title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#172b20}a{color:#246b47}nav{display:flex;gap:1rem;flex-wrap:wrap}h1{line-height:1.2}</style>
</head><body><nav><a href="/about">Project</a><a href="/privacy">Privacy</a>
<a href="/terms">Evaluation usage</a></nav><main><h1>${notice.title}</h1>
${notice.body}</main></body></html>`;
}
