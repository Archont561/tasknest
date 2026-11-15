@discovery
Feature: Task Registration and File-Based Discovery

  Rule: Configured roots discover one task per file with namespaces and docstrings

    @smoke
    Scenario: Nested task files produce dotted canonical names and CLI paths
      Given a configured root "tools" with namespace "repo"
      And a task file "check/dev.py" with docstring "Run development checks."
      When tasks are discovered for the workspace
      Then task "repo.check.dev" is registered with CLI path "repo check dev"
      And task "repo.check.dev" has description "Run development checks."

  Rule: Underscore paths and reserved support directories are ignored

    Scenario: Helpers and reserved test or feature directories are excluded
      Given a configured root "tools" with namespace ""
      And an ignored helper file "_helpers.py"
      And an ignored file inside "_private/secret.py"
      And an ignored file inside "tests/test_smoke.py"
      And an ignored file inside "features/steps.py"
      And a task file "lint.py" with docstring "Lint workspace."
      When tasks are discovered for the workspace
      Then only task "lint" is registered

  Rule: Invalid registrations and duplicate names fail discovery

    Scenario: File without a registered task is rejected
      Given a configured root "tools" with namespace ""
      And a task file "empty.py" containing no tool definition
      When tasks are discovered for the workspace
      Then discovery fails explaining one task per file is required

    Scenario: File registering multiple tasks is rejected
      Given a configured root "tools" with namespace ""
      And a task file "multi.py" containing two tool definitions
      When tasks are discovered for the workspace
      Then discovery fails explaining one task per file is required

    Scenario: Duplicate canonical task names across roots are rejected
      Given two configured roots "root_a" and "root_b" without namespaces
      And both roots define a task file "lint.py"
      When tasks are discovered for the workspace
      Then discovery fails explaining duplicate task "lint"
