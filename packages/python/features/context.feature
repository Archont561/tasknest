@context
Feature: Execution Context and Subprocess Helper

  Rule: Context distinguishes repository and configured project roots

    @smoke
    Scenario: Command runs inside the configured project root by default
      Given a workspace with a subpackage root "apps/api"
      When a task executes a command without specifying cwd
      Then the command working directory is "apps/api"
      And the task context still exposes the repository root

    Scenario: Command merges explicit environment overrides
      Given a workspace with a subpackage root "apps/api"
      When a task executes a command with environment variable "TASKNEST_ENV=ci"
      Then the captured command output contains "ci"

  Rule: Subprocesses run without a shell and fail on nonzero exits or timeouts

    Scenario: Raw shell command string is rejected
      Given a workspace with a subpackage root "."
      When a task passes a raw shell string to the command helper
      Then a tool failure is raised explaining an argv sequence is required

    Scenario: Nonzero command exit fails the task
      Given a workspace with a subpackage root "."
      When a task runs a command that exits with code 4
      Then a tool failure is raised with exit code 4

    Scenario: Command exceeding timeout fails the task
      Given a workspace with a subpackage root "."
      When a task runs a slow command with a short timeout
      Then a tool failure is raised explaining the command timed out
