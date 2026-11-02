extends SceneTree

const GameState = preload("res://state.gd")
var checks: Array[Dictionary] = []

func check(name: String, passed: bool) -> void:
	checks.append({"name": name, "passed": passed})
	if not passed:
		push_error("TEST_FAILED: " + name)

func _init() -> void:
	var state = GameState.new()
	check("initial stars", state.stars.size() == 5 and state.collected == 0)
	state.move(Vector2.RIGHT, 0.25)
	check("movement distance", is_equal_approx(state.player.x, 180.0))
	state.reset()
	state.move(Vector2(1, 1), 0.25)
	check("diagonal speed", is_equal_approx(state.player.distance_to(Vector2(120, 270)), 60.0))
	state.move(Vector2.LEFT, 100)
	check("world bounds", state.player.x >= state.RADIUS)
	state.player = state.stars[0]
	state.move(Vector2.ZERO, 0)
	check("star collection", state.collected == 1 and state.stars.size() == 4)
	state.reset()
	check("restart state", state.collected == 0 and state.stars.size() == 5 and state.player == Vector2(120, 270))
	DirAccess.make_dir_recursive_absolute("res://lightmao_artifacts")
	var file = FileAccess.open("res://lightmao_artifacts/test-results.json", FileAccess.WRITE)
	if not file:
		push_error("Cannot save test results")
		quit(2)
		return
	file.store_string(JSON.stringify({"schema": 1, "tests": checks}, "  "))
	file.close()
	var passed = checks.all(func(item): return item.passed)
	var image = Image.create(240, 80, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.04, 0.07, 0.12))
	for index in range(checks.size()):
		image.fill_rect(Rect2i(10 + index * 38, 20, 26, 40), Color(0.35, 0.85, 0.65) if checks[index].passed else Color(0.95, 0.35, 0.35))
	image.save_png("res://lightmao_artifacts/test-status.png")
	print("LIGHTMAO_TESTS: %d checks; passed=%s" % [checks.size(), passed])
	quit(0 if passed else 1)
