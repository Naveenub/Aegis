# Aegis AI Engineering Platform

Aegis is an enterprise-grade autonomous AI software engineering system designed to function as a multi-agent development team.

## 🚀 Core Capabilities

- Multi-agent orchestration (planner, debugger, reviewer, etc.)
- Autonomous code generation and fixing
- Guardrail-based safety system
- Review + approval pipeline
- Self-improving feedback loop
- API + CLI driven execution

## 🧠 Architecture

Aegis operates as a distributed AI engineering system with:

- Planning layer
- Execution agents
- Review guard system
- Memory + learning layer
- Observability + logging

## ⚙️ Usage

```bash
npm install
node cli/claude.js "Fix login bug"
```

## 🌐 API

```http
POST /task
{
  "task": "Build authentication system"
}
```

## ⚠️ Notes

- Designed for semi-autonomous execution
- Requires human oversight for critical systems
- Improves with continuous usage and prompt tuning

---

# 🔧 Optional: Rename CLI Command (Cleaner UX)

## cli/claude.js → cli/aegis.js

Then update:

```json
"bin": {
  "aegis": "./cli/aegis.js"
}
```

Now you can run:

```bash
aegis "Fix payment bug"
```

