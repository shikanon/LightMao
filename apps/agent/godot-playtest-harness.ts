// Fixed SceneTree driver in the authorized project copy. Commands are observed IDs, never code.
export const godotPlaytestHarness = `extends SceneTree
var scene: Node
var step_number := 0
var trace: Array = []
var allowed: Array = []
const MAX_INPUTS = 64
const KEYS = {"UP":KEY_UP,"DOWN":KEY_DOWN,"LEFT":KEY_LEFT,"RIGHT":KEY_RIGHT,"W":KEY_W,"A":KEY_A,"S":KEY_S,"D":KEY_D,"SPACE":KEY_SPACE,"ENTER":KEY_ENTER,"ESCAPE":KEY_ESCAPE,"R":KEY_R,"E":KEY_E,"SHIFT":KEY_SHIFT,"0":KEY_0,"1":KEY_1,"2":KEY_2,"3":KEY_3,"4":KEY_4,"5":KEY_5,"6":KEY_6,"7":KEY_7,"8":KEY_8,"9":KEY_9}

func _initialize() -> void:
\tcall_deferred("start_game")

func start_game() -> void:
\tvar path = ProjectSettings.get_setting("application/run/main_scene", "")
\tvar packed = load(path)
\tif not packed is PackedScene:
\t\tpush_error("Missing playable main scene")
\t\tquit(1)
\t\treturn
\tscene = packed.instantiate()
\troot.add_child(scene)
\tcurrent_scene = scene
\tawait process_frame
\tawait process_frame
\twhile step_number <= MAX_INPUTS:
\t\tallowed = []
\t\tif scene.has_method("lightmao_actions"):
\t\t\tvar proposed = scene.call("lightmao_actions")
\t\t\tif proposed is Array:
\t\t\t\tfor item in proposed.slice(0, 24):
\t\t\t\t\tif item is Dictionary and item.has("id") and KEYS.has(str(item.get("key", ""))):
\t\t\t\t\t\tallowed.append({"id":str(item.id).substr(0,60),"label":str(item.get("label",item.id)).substr(0,300),"key":str(item.key),"frames":clampi(int(item.get("frames",12)),1,120)})
\t\tif step_number >= MAX_INPUTS:
\t\t\tallowed = []
\t\tvar state: Dictionary = {}
\t\tif scene.has_method("lightmao_observe"):
\t\t\tvar reported = scene.call("lightmao_observe")
\t\t\tif reported is Dictionary:
\t\t\t\tstate = reported
\t\tstate["engine_scene"] = str(scene.name)
\t\tstate["driver_inputs"] = step_number
\t\tvar observation = {"id":str(step_number),"state":state,"actions":allowed}
\t\tvar encoded = JSON.stringify(observation)
\t\tif encoded.length() > 24000:
\t\t\tpush_error("Playtest observation exceeds limit")
\t\t\tquit(1)
\t\t\treturn
\t\ttrace.append(observation)
\t\tprint("LIGHTMAO_PLAYTEST_OBSERVATION:" + encoded)
\t\tvar command = JSON.parse_string(OS.read_string_from_stdin())
\t\tif not command is Dictionary:
\t\t\tquit(2)
\t\t\treturn
\t\tif command.get("quit", false) == true:
\t\t\tDirAccess.make_dir_recursive_absolute("res://lightmao_artifacts")
\t\t\tvar file = FileAccess.open("res://lightmao_artifacts/playtest-observations.json", FileAccess.WRITE)
\t\t\tfile.store_string(JSON.stringify(trace, "  "))
\t\t\tif DisplayServer.get_name() != "headless":
\t\t\t\tawait RenderingServer.frame_post_draw
\t\t\t\troot.get_texture().get_image().save_png("res://lightmao_artifacts/native-playtest.png")
\t\t\tquit(0)
\t\t\treturn
\t\tif step_number >= MAX_INPUTS:
\t\t\tpush_error("Playtest input budget reached; only final quit is allowed")
\t\t\tquit(1)
\t\t\treturn
\t\tvar selected: Dictionary = {}
\t\tfor action in allowed:
\t\t\tif action.id == command.get("actionId", ""):
\t\t\t\tselected = action
\t\tif selected.is_empty():
\t\t\tpush_error("Unobserved playtest action")
\t\t\tquit(1)
\t\t\treturn
\t\tvar event = InputEventKey.new()
\t\tevent.keycode = KEYS[selected.key]
\t\tevent.physical_keycode = KEYS[selected.key]
\t\tevent.pressed = true
\t\tInput.parse_input_event(event)
\t\tfor frame in range(int(selected.frames)):
\t\t\tawait process_frame
\t\tevent.pressed = false
\t\tInput.parse_input_event(event)
\t\tawait process_frame
\t\tstep_number += 1
\tquit(1)
`;
