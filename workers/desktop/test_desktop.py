"""使用合成值检查坐标、旁白保留时间和 FFmpeg 时间基准。"""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from capture import sync_samples
from main import prepare_data, StopRequested
from observer import EdgeObserver, map_rect, step_end_ms, StepError


class DesktopMathTests(unittest.TestCase):
    def test_maps_physical_viewport_with_offset_and_scale(self):
        rect = {"x": 24, "y": 40, "width": 80, "height": 32}
        self.assertEqual(map_rect(rect, (120, 150, 1200, 800), (960, 640), (1920, 1080)),
                         {"x": 150, "y": 200, "width": 100, "height": 40})

    def test_rejects_clipped_targets_and_unreliable_scale(self):
        rect = {"x": 941, "y": 10, "width": 20, "height": 10}
        with self.assertRaises(ValueError):
            map_rect(rect, (120, 150, 1200, 800), (960, 640), (1920, 1080))
        with self.assertRaises(ValueError):
            map_rect({**rect, "x": 4}, (120, 150, 1200, 700), (960, 640), (1920, 1080))

    def test_hold_covers_narration_at_its_own_anchor(self):
        self.assertEqual(step_end_ms(1000, 1200, 100, [300, 500], [250]), 2300)
        self.assertEqual(step_end_ms(1000, 1200, 800, [], [250]), 2500)

    def test_uses_frame_pts_for_zero_point_and_elapsed_video(self):
        self.assertEqual(sync_samples(1_700_000_000_500_000, 1_700_000_001_700_000,
                                      (1_700_000_000_000, 10000), (1_700_000_002_000, 12000)),
                         [{"monotonicMs": 10500, "videoMs": 0}, {"monotonicMs": 11700, "videoMs": 1200}])

    def test_rejects_wall_clock_jump_or_session_relative_pts(self):
        with self.assertRaises(ValueError):
            sync_samples(1_700_000_000_500_000, 1_700_000_001_700_000,
                         (1_700_000_000_000, 10000), (1_700_000_003_000, 12000))
        with self.assertRaises(ValueError):
            sync_samples(0, 1_200_000, (1_700_000_000_000, 10000), (1_700_000_002_000, 12000))


class InputBoundaryTests(unittest.TestCase):
    def observer(self):
        observer = EdgeObserver.__new__(EdgeObserver)
        observer.profile = {"moveMs": 100, "preClickMs": 50}
        observer.input = Mock()
        observer.input.position.return_value = (30, 30)
        observer.guard = Mock()
        observer.control = Mock()
        observer._move = Mock()
        return observer

    def test_click_never_dispatches_after_cancel_during_pause(self):
        observer = self.observer()
        observer._position = Mock(return_value=({"x": 20, "y": 20, "width": 20, "height": 20}, {"disabled": False}))
        observer.control.pause.side_effect = StopRequested()
        with self.assertRaises(StopRequested):
            observer.action({"op": "click", "target": "save"})
        observer.input.click.assert_not_called()

    def test_click_never_dispatches_when_layout_moves(self):
        observer = self.observer()
        box = {"x": 20, "y": 20, "width": 20, "height": 20}
        state = {"disabled": False}
        observer._position = Mock(side_effect=[(box, state), ({**box, "x": 25}, state)])
        with self.assertRaises(StepError):
            observer.action({"op": "click", "target": "save"})
        observer.input.click.assert_not_called()

    def test_refresh_waits_for_a_new_document_before_returning(self):
        observer = self.observer()
        observer._position = Mock(return_value=({}, {}))
        observer._frame = Mock()
        observer.page = Mock()
        observer.page.evaluate.return_value = 12345
        observer.action({"op": "refresh", "target": "workspace"})
        observer.input.press.assert_called_once_with("f5")
        observer.page.wait_for_function.assert_called_once()
        self.assertEqual(observer.page.wait_for_function.call_args.kwargs["arg"], 12345)
        observer.page.wait_for_load_state.assert_called_once()

    def test_explicit_data_strategies_only_write_project_state(self):
        with TemporaryDirectory() as directory:
            state = Path(directory, "state.json")
            seed = Path(directory, "seed.json")
            state.write_text('{"current":true}', encoding="utf-8")
            seed.write_text('{"seed":true}', encoding="utf-8")
            target = {"data": {"statePath": str(state), "seedPath": str(seed)}}
            control = Mock()
            prepare_data({"strategy": "keep"}, target, control)
            self.assertEqual(json.loads(state.read_bytes()), {"current": True})
            prepare_data({"strategy": "seed"}, target, control)
            self.assertEqual(json.loads(state.read_bytes()), {"seed": True})
            prepare_data({"strategy": "custom", "state": [{"value": "合成"}]}, target, control)
            self.assertEqual(json.loads(state.read_bytes()), [{"value": "合成"}])
            self.assertEqual(json.loads(seed.read_bytes()), {"seed": True})


if __name__ == "__main__":
    unittest.main()
