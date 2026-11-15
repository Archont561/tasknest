"""Basic package scaffold checks."""

from tasknest import __version__


def test_version_is_defined() -> None:
    assert __version__.endswith(".dev0")
