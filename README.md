# Aegis

Aegis is an autonomous AI engineering system designed to function as a multi-agent software development team.

It can plan, build, debug, test, and improve software using coordinated AI agents with built-in safety guardrails.

---

## 🚀 Features

- 🧠 Multi-agent architecture (planner, debugger, reviewer, etc.)
- ⚙️ Autonomous code generation and fixing
- 🛡 Guardrail-based safety system
- 🔁 Review + approval pipeline
- 📊 Logging and decision tracking
- 🌐 API + CLI interface
- 🧪 Test-aware workflows

---

## 🧱 Architecture Overview

Aegis operates in the following flow:

```
Task  
↓  
Planner  
↓  
Agents (parallel / sequential)  
↓  
Review Guard  
↓  
Patch Apply  
↓  
Test Gate  
↓  
Commit  
↓  
Learning (memory)
```

---

## 📁 Project Structure

```
aegis/
├── .claude/ # agents, rules, memory
├── cli/ # CLI interface
├── engine/ # orchestration logic
├── workers/ # background processing
├── scripts/ # automation scripts
├── server.js # API server
```

---

## ⚙️ Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create ```.env``` file:

```env
ANTHROPIC_API_KEY=your_api_key
CLAUDE_AUTONOMY=true
MODE=approval
```

---

## 🧠 Usage

### CLI

```bash
node cli/claude.js "Fix login bug"
```

👉 Optional (recommended):
Rename CLI to ```aegis``` for cleaner usage.

### API

```http
POST /task
Content-Type: application/json

{
  "task": "Build authentication system"
}
```
---

## 🤖 Agents

Core agents:

- planner → breaks tasks into steps
- debugger → finds and fixes bugs
- refactorer → improves code quality
- test-writer → generates tests
- review-guard → validates safety
- security-editor → detects vulnerabilities
- feature-builder → builds features
- meta-reviewer → improves system over time

---

## 🛡 Safety & Guardrails

Aegis includes multiple protection layers:

- restricted file access (```.env```, secrets)
- patch validation before applying changes
- mandatory review-guard approval
- automatic file backup before overwrite

---

## 📊 Observability

- logs via ```pino```
- decisions stored in:
```.claude/context/decisions.log```
- memory stored in:
```.claude/context/memory.json```

---

## ⚠️ Limitations

- Not a zero-error system
- Requires human oversight for critical systems
- Performance depends heavily on prompt quality

---

## 🧭 Roadmap

- vector memory (RAG)
- GitHub PR automation
- UI dashboard
- multi-repo coordination
- SaaS platform

---

## 📜 License

MIT (recommended)

---

## 💡 Philosophy

Aegis is not built to replace engineers.

It is built to amplify engineering capability, allowing small teams to operate with the output of much larger organizations.
