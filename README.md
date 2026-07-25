# Delivery Operations

A synthetic full-stack delivery operations analytics platform built to demonstrate operational monitoring, diagnostic workflows, AI-assisted analysis, and scalable internal tooling.

> **Portfolio note:** Delivery Operations is a fully synthetic reconstruction inspired by the types of operational challenges I have worked on. All companies, locations, users, data, metrics, calculations, thresholds, and business rules in this public repository are fictional.

## Live Demo

[![Launch Delivery Operations Demo](https://img.shields.io/badge/Launch_Delivery_Operations-Demo-0ea5e9?style=for-the-badge&logo=rocket)](#one-click-launch)

Click the button for the one-click Windows, macOS, and Linux launch instructions. The demo runs locally with a ready-made account and synthetic data.

## Overview

Delivery Operations brings several operational workflows into one analytics environment.

The platform is designed to help an operations team:

- monitor performance across regions, countries, and cities
- investigate delayed deliveries and operational bottlenecks
- compare markets, locations, couriers, and venues
- review geographic pickup and drop-off patterns
- move from high-level KPIs into detailed root-cause analysis
- generate structured AI-assisted summaries
- export operational views for stakeholder reporting

The project demonstrates how fragmented dashboards, spreadsheets, and manual investigations can be converted into a more scalable, self-service workflow.

## The Problem

Operational teams often rely on several disconnected tools to understand marketplace performance.

A typical investigation may require:

- checking multiple dashboards
- exporting data into spreadsheets
- assembling separate operational reports
- manually comparing markets
- writing summaries for stakeholders
- repeating the same investigation when a metric changes again

This creates several problems:

- investigations take too long
- stakeholders depend on analysts for routine questions
- metric definitions become inconsistent
- important issues are identified too late
- findings are difficult to communicate clearly
- repeated analysis is not captured as a reusable workflow

## The Solution

Delivery Operations demonstrates a unified operational analytics workflow that connects:

- performance monitoring
- regional and local comparisons
- delivery diagnostics
- courier and venue analysis
- geographic investigation
- AI-assisted interpretation
- export and reporting workflows

The goal is not only to display metrics, but to help a user move from:

```text
What changed?
      |
      v
Where is the issue?
      |
      v
What is driving it?
      |
      v
What should be investigated next?
```

## Key Features

### Multi-level performance monitoring

Users can move between regional, country, and city views while retaining a consistent analytical structure.

This supports both high-level monitoring and local investigation.

### Delivery diagnostics

The platform includes focused analytical views for:

- delayed deliveries
- delivery-time performance
- courier-level performance
- venue-level diagnostics
- vehicle distribution
- operational overlap patterns
- hourly and daily performance trends
- geographic pickup and drop-off activity

### Venue diagnostics

Venue-level workflows help identify locations that may be contributing disproportionately to operational issues.

The diagnostic experience includes:

- performance trends
- peer comparisons
- hourly patterns
- operational findings
- recommended investigation areas
- location context
- conversation-theme analysis

### Courier analysis

Courier-focused views support investigation of:

- travel patterns
- delivery performance
- operational benchmarks
- vehicle distribution
- market-level courier behavior

### Geographic analysis

Interactive map views provide geographic context for operational activity, including pickup points, drop-off patterns, venues, and local performance differences.

### AI-assisted summaries

The AI layer transforms structured operational data into:

- concise summaries
- highlighted findings
- suggested investigation areas
- recommended next steps
- stakeholder-friendly explanations

The AI functionality is designed to support the analyst rather than replace the underlying metrics, operational judgment, or decision-making process.

### Synthetic data engine

The public version includes synthetic data generation so the application can demonstrate realistic operational workflows without exposing confidential information.

### Export and stakeholder reporting

Users can export selected analytical views for further reporting, stakeholder communication, and offline analysis.

### Cache and refresh workflows

The backend includes caching, freshness checks, background refresh patterns, and stale-data handling to demonstrate how an operational tool can remain responsive while working with larger analytical datasets.

## Example Investigation Workflow

A typical investigation might look like this:

1. Identify a market with deteriorating delivery-time performance.
2. Compare the affected cities against regional benchmarks.
3. Review hourly and daily trends.
4. Inspect courier, venue, vehicle, and geographic patterns.
5. Identify the strongest operational signals.
6. Use the AI summary to structure the findings.
7. Export the analysis for stakeholder review.
8. Monitor whether the selected intervention improves performance.

## Architecture

```text
React + TypeScript frontend
        |
        | REST API
        v
FastAPI backend
        |
        |-- Synthetic data engine
        |-- Operational metric processing
        |-- AI summary service
        |-- Cache and refresh layer
        |-- Export services
        |-- Optional synthetic data source-compatible data layer
```

## Technology Stack

### Frontend

- React
- TypeScript
- Vite
- Deck.gl
- interactive dashboard components
- responsive data visualizations
- reusable filters and analytical panels

### Backend

- Python
- FastAPI
- deterministic scenario-processing workflows
- caching and refresh services
- synthetic data generation
- AI-assisted analysis services
- export endpoints
- authentication and session patterns

### Data and Infrastructure

- bundled fictional scenario generator
- Docker
- environment-based configuration
- CSV and JSON export workflows
- deterministic synthetic-data execution
- automated tests

## My Role

I defined and implemented the project across the full workflow, including:

- problem definition
- product structure
- analytical workflows
- metric and diagnostic logic
- information architecture
- frontend experience
- backend services
- synthetic public-data strategy
- AI summary workflows
- documentation
- testing and validation

My focus was not only on writing code, but on translating an operational problem into a usable analytical product.

## AI-Assisted Development

I used Claude Code and Codex to accelerate:

- implementation
- debugging
- code review
- testing
- documentation
- refactoring
- the creation of the synthetic public version

The AI tools supported development, but the following were defined and validated by me:

- product direction
- operational use cases
- workflow design
- analytical structure
- architecture decisions
- metric logic
- user experience
- validation criteria
- public-release safeguards

## Why This Project Matters

Delivery Operations is not intended to be a production delivery platform.

It is a portfolio project demonstrating how I approach:

- operational problem solving
- analytical workflow design
- internal tool development
- AI-assisted operations
- process automation
- stakeholder enablement
- diagnostic thinking
- translating business problems into technical solutions

## Running Locally

### One-click launch

After downloading or cloning the repository:

- **Windows:** double-click `LAUNCH_APP.bat`
- **macOS:** double-click `start.command`
- **Linux:** run `./run.sh`

The launcher creates the local synthetic-demo configuration, installs missing
dependencies on the first run, starts the API and dashboard, and opens the app
in your browser.

Demo login:

```text
Username: demo
Password: delivery-demo
```

The first launch can take several minutes while dependencies are installed.
Later launches reuse them and start much faster. Close the server windows, or
press `Ctrl+C`, to stop the app.

### Prerequisites

- Python 3.11 or newer
- Node.js 20 or newer
- npm
- Git

### Clone the repository

```bash
git clone https://github.com/gaslanidis17/delivery-analytics.git
cd delivery-analytics
```

### Backend setup

Move into the backend folder:

```bash
cd backend
```

Create a virtual environment:

```bash
python -m venv .venv
```

Activate it on Windows:

```powershell
.venv\Scripts\Activate.ps1
```

Activate it on macOS or Linux:

```bash
source .venv/bin/activate
```

Install the backend dependencies:

```bash
pip install -r requirements.txt
```

Return to the project root and create the local environment file:

```powershell
Copy-Item .env.example .env
```

Start the API from the backend folder:

```bash
uvicorn app.main:app --reload
```

The FastAPI documentation should then be available at:

```text
http://localhost:8000/docs
```

### Frontend setup

Open a second terminal and move into the frontend folder:

```bash
cd frontend
```

Install the frontend dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the local URL displayed by Vite.

## Configuration

The repository includes an `.env.example` file showing the expected configuration variables.

The public version runs exclusively on bundled synthetic data.

Do not commit:

- real credentials
- API keys
- access tokens
- production URLs
- company connection details
- personal user data

## Testing

Run the backend tests:

```bash
cd backend
pytest
```

Build the frontend:

```bash
cd frontend
npm run build
```

Run frontend linting:

```bash
npm run lint
```

## Project Structure

```text
delivery-analytics/
|
|-- backend/
|   |-- app/
|   |   |-- routers/
|   |   |-- services/
|   |   `-- main.py
|   |
|   |-- tests/
|   |-- requirements.txt
|   `-- Dockerfile
|
|-- frontend/
|   |-- public/
|   |-- src/
|   |   |-- api/
|   |   |-- components/
|   |   |-- hooks/
|   |   |-- lib/
|   |   |-- pages/
|   |   `-- types/
|   |
|   |-- package.json
|   |-- vite.config.ts
|   `-- Dockerfile
|
|-- .env.example
|-- README.md
|-- PORTFOLIO.md
`-- PUBLIC_RELEASE_CHECKLIST.md
```

## Screenshots

Screenshots will be added after the hosted demo version is finalized.

Planned screenshots include:

1. Regional operations overview
2. Country-level analytics
3. Venue diagnostics
4. Courier performance analysis
5. Geographic delivery view
6. AI-assisted summary panel

## Current Status

The current portfolio version includes:

- multi-market operational dashboards
- regional, country, and city views
- venue and courier diagnostics
- geographic analysis
- synthetic operational data
- AI-assisted summaries
- export workflows
- caching and refresh patterns
- backend testing
- Docker configuration

## Roadmap

Planned improvements include:

- hosted live demo
- direct synthetic demo access
- simplified demo authentication
- automated deployment
- additional screenshots
- expanded test coverage
- improved onboarding documentation
- stronger mobile responsiveness
- additional example investigation workflows

## Synthetic Data and Privacy

This repository does not contain:

- company data
- production credentials
- confidential documentation
- real employee information
- real courier information
- real venue information
- proprietary production business rules

All public examples, entities, data, calculations, thresholds, and operational rules are fictional.

## Disclaimer

Delivery Operations is a personal portfolio project.

It is not affiliated with, endorsed by, or connected to any employer, delivery platform, logistics company, or technology provider.

## Author

**Georgios Aslanidis**

Operations specialist focused on analytics, automation, AI-assisted workflows, and scalable internal tooling.

[LinkedIn](https://www.linkedin.com/in/georgios-aslanidis/)

[GitHub](https://github.com/gaslanidis17)
