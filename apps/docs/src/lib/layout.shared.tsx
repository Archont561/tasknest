import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Tasknest",
    },
    githubUrl: "https://github.com/Archont561/tasknest",
    links: [
      {
        text: "Documentation",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "CLI Contract",
        url: "/docs/contract",
      },
      {
        text: "Orchestration",
        url: "/docs/orchestration",
      },
    ],
  };
}
