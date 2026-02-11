---
description: Review for security
---
Review the code for security vulnerabilities.

**Look for:**
- Input validation gaps
- Authentication/authorization bypasses
- Injection vulnerabilities (SQL, XSS, command, LDAP)
- Sensitive data exposure (logs, errors, responses)
- Hardcoded secrets or credentials
- Insecure cryptographic usage
- Path traversal vulnerabilities
- SSRF (Server-Side Request Forgery)
- Deserialization vulnerabilities
- OWASP Top 10 concerns

**In a charm, also check for:**
- Unsanitized input from relation data (a compromised related unit could inject malicious values)
- Subprocess calls built from user or relation input without proper escaping (command injection)
- Secrets or credentials written to unit logs or stored in plaintext relation data instead of using Juju secrets

**Questions to answer:**
- What can a malicious user do with this code?
- What data could be exposed if this fails?
- Are there defense-in-depth gaps?