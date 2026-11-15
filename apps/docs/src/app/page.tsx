import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Cpu, Layers, ShieldCheck, Terminal, Watch, Zap } from "lucide-react";
import Link from "next/link";
import { baseOptions } from "@/lib/layout.shared";

const features = [
  {
    icon: Terminal,
    title: "File-Based Discovery",
    description:
      "One task per file under tools/. Nested paths derive canonical names and space-separated CLI commands automatically.",
    href: "/docs/contract",
  },
  {
    icon: Layers,
    title: "Data Passing & Scoped Env",
    description:
      "Emit validated JSON outputs via ctx.output(), consume upstream results via read-only ctx.deps[], and track env keys without mutating global env.",
    href: "/docs/orchestration/data-passing",
  },
  {
    icon: Zap,
    title: "Opt-In Content Cache",
    description:
      "Share .tasknest/cache/ across tasknest-py and tasknest-ts with early cutoff, missing-output invalidation, and --force/--no-cache.",
    href: "/docs/orchestration/caching",
  },
  {
    icon: Cpu,
    title: "Parallelism & Resource Locks",
    description:
      "Opt-in --jobs concurrency, resource conflict locks, TASKNEST_WORKER_BUDGET bounds, and --fail-fast cancellation.",
    href: "/docs/orchestration/parallelism",
  },
  {
    icon: Watch,
    title: "DAG-Aware Watch Mode",
    description:
      "Monitor declared inputs across the resolved DAG, ignore self-declared outputs, and re-run only the dirty subgraph.",
    href: "/docs/orchestration/watch",
  },
  {
    icon: ShieldCheck,
    title: "Reports, Affected & Skills",
    description:
      "Versioned redacted JSON reports (--json/--report), conservative affected test selection, and deterministic agent SKILL.md generation.",
    href: "/docs/orchestration/reports",
  },
];

export default function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-12 px-6 py-16">
        <section className="flex flex-col items-start gap-6">
          <span className="inline-flex items-center rounded-full border border-fd-border bg-fd-secondary px-3 py-1 text-xs font-medium text-fd-secondary-foreground">
            v0.4.0 · Python &amp; TypeScript (Bun + Node.js)
          </span>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Native Python &amp; TypeScript file-based task runners.
          </h1>
          <p className="max-w-2xl text-lg text-fd-muted-foreground">
            Write tasks as plain Python or TypeScript modules with typed CLI options, explicit
            dependency graphs, opt-in content caching, parallel execution, watch mode, and
            machine-readable reports.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Read the Docs
            </Link>
            <Link
              href="/docs/getting-started"
              className="rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-medium text-fd-card-foreground transition-colors hover:bg-fd-accent"
            >
              Quick Start
            </Link>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.title}
                href={item.href}
                className="flex flex-col gap-2 rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:bg-fd-accent/50"
              >
                <div className="flex items-center gap-2 text-fd-foreground">
                  <Icon className="h-4 w-4 text-fd-primary" />
                  <h2 className="font-semibold">{item.title}</h2>
                </div>
                <p className="text-sm text-fd-muted-foreground">{item.description}</p>
              </Link>
            );
          })}
        </section>
      </main>
    </HomeLayout>
  );
}
