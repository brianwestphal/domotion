.PHONY: prep-macos-dev prep-macos-dev-check

prep-macos-dev:
	zsh -ic 'bash scripts/prep-macos-dev.sh'

prep-macos-dev-check:
	zsh -ic 'bash scripts/prep-macos-dev.sh --check'
