@graph
Feature: Dependency Graph Validation and Sequential Execution

  Rule: Cycles and unknown dependencies are rejected before any task executes

    Scenario: Unknown dependency fails validation
      Given task "build" depends on canonical name "missing.step"
      When the dependency graph is validated
      Then graph validation fails mentioning unknown dependency "missing.step"

    Scenario: Dependency cycle fails validation
      Given task "alpha" depends on "beta" and task "beta" depends on "alpha"
      When the dependency graph is validated
      Then graph validation fails showing cycle "alpha -> beta -> alpha"

  Rule: Shared dependencies run once per invocation in topological order

    @smoke
    Scenario: Diamond dependency graph executes shared prerequisite once
      Given task "base" has no dependencies
      And task "left" depends on canonical name "base"
      And task "right" depends on task reference "base"
      And task "top" depends on "left" and "right"
      When task "top" runs sequentially
      Then all tasks succeed in order "base, left, right, top"
      And task "base" executed exactly 1 time

  Rule: Failed tasks block downstream dependents and return nonzero

    Scenario: Prerequisite failure blocks dependents while independent siblings run
      Given task "prepare" fails with exit code 3
      And task "build" depends on "prepare"
      And task "lint" has no dependencies
      And task "package" depends on "build" and "lint"
      When task "package" runs sequentially
      Then execution returns exit code 3
      And failed tasks are "prepare"
      And succeeded tasks are "lint"
      And blocked tasks are "build, package"
