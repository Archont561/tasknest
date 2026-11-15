@cli
Feature: Tasknest Command-Line Interface and Typed Arguments

  Rule: Subcommands expose discovery, validation, planning, and execution

    @smoke
    Scenario: Listing, checking, and planning nested tasks
      Given a CLI workspace with nested task "check/dev.py" and dependent task "lint.py"
      When I run the CLI with "ls"
      Then the CLI succeeds with output containing "check dev (check.dev)"
      When I run the CLI with "check"
      Then the CLI succeeds with output containing "OK"
      When I run the CLI with "plan lint"
      Then the CLI succeeds with output containing "1. check.dev"

  Rule: Typed task options validate values and defaults without a mandatory separator

    Scenario: Typed options accept values without a separator
      Given a CLI workspace with typed task "greet.py"
      When I run the CLI with "run greet --target src --fix --jobs=3 --mode full --tags a --tags b"
      Then the CLI succeeds with output containing "GREET:src:True:3:full:a,b"

    Scenario: Invalid option value or missing required option fails with usage exit code
      Given a CLI workspace with typed task "greet.py"
      When I run the CLI with "run greet --jobs notanint"
      Then the CLI fails with exit code 2

  Rule: Global options before the subcommand never collide with task options

    Scenario: Task option named root does not collide with global root option
      Given a CLI workspace with task "a.py" accepting option "root" and child task "a/b.py"
      When I run the CLI with "run a --root custom"
      Then the CLI succeeds with output containing "A:default:custom"

  Rule: Longest path matches sub-tasks while double-dash passes positional arguments

    Scenario: Longest match selects nested task while double-dash disambiguates positional argument
      Given a CLI workspace with task "a.py" accepting option "root" and child task "a/b.py"
      When I run the CLI with "run a b"
      Then the CLI succeeds with output containing "B_CHILD"
      When I run the CLI with "run a -- b --root custom"
      Then the CLI succeeds with output containing "A:b:custom"
