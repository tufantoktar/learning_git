import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_daily_runner_script_exists_and_is_executable():
    script = PROJECT_ROOT / "scripts" / "run_daily_tefas.sh"

    assert script.exists()
    assert os.access(script, os.X_OK)


def test_launchd_plist_example_contains_project_dir_placeholder():
    plist = PROJECT_ROOT / "scripts" / "com.tefas.analysis.daily.plist.example"

    assert plist.exists()
    assert "__PROJECT_DIR__" in plist.read_text(encoding="utf-8")


def test_launchd_install_and_uninstall_scripts_exist_and_are_executable():
    install_script = PROJECT_ROOT / "scripts" / "install_launchd_daily.sh"
    uninstall_script = PROJECT_ROOT / "scripts" / "uninstall_launchd_daily.sh"

    assert install_script.exists()
    assert uninstall_script.exists()
    assert os.access(install_script, os.X_OK)
    assert os.access(uninstall_script, os.X_OK)
