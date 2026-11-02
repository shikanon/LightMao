extends Node2D

const GameState = preload("res://state.gd")
var state = GameState.new()
var elapsed = 0.0

func _ready() -> void:
	print("LIGHTMAO_SCENE_READY: Startrail")
	if DisplayServer.get_name() == "headless":
		DirAccess.make_dir_recursive_absolute("res://lightmao_artifacts")
		var report = FileAccess.open("res://lightmao_artifacts/scene-state.json", FileAccess.WRITE)
		if report:
			report.store_string(JSON.stringify({"scene": "Startrail", "stars": state.stars.size(), "player": [state.player.x, state.player.y], "verification": "scene_initialized"}, "  "))

func _process(delta: float) -> void:
	elapsed += delta
	var direction = Vector2(
		int(Input.is_physical_key_pressed(KEY_D) or Input.is_physical_key_pressed(KEY_RIGHT)) - int(Input.is_physical_key_pressed(KEY_A) or Input.is_physical_key_pressed(KEY_LEFT)),
		int(Input.is_physical_key_pressed(KEY_S) or Input.is_physical_key_pressed(KEY_DOWN)) - int(Input.is_physical_key_pressed(KEY_W) or Input.is_physical_key_pressed(KEY_UP))
	)
	state.move(direction, delta)
	if Input.is_physical_key_pressed(KEY_R):
		state.reset()
	queue_redraw()

func _draw() -> void:
	var font = ThemeDB.fallback_font
	draw_string(font, Vector2(40, 45), "STARTRAIL", HORIZONTAL_ALIGNMENT_LEFT, -1, 26, Color(0.84, 0.91, 1))
	draw_string(font, Vector2(680, 45), "STARS  %d / 5" % state.collected, HORIZONTAL_ALIGNMENT_LEFT, -1, 20, Color(1, 0.83, 0.4))
	for x in range(40, 960, 40):
		for y in range(100, 500, 40):
			draw_circle(Vector2(x, y), 1.2, Color(0.18, 0.25, 0.34))
	for point in state.stars:
		draw_circle(point, 20 + sin(elapsed * 2) * 3, Color(0.9, 0.7, 0.3, 0.08))
		var shape = PackedVector2Array()
		for index in range(10):
			shape.append(point + Vector2.from_angle(index * PI / 5 - PI / 2) * (12.0 if index % 2 == 0 else 5.5))
		draw_colored_polygon(shape, Color(1, 0.85, 0.5))
	draw_circle(state.player, 25, Color(0.45, 0.6, 1, 0.12))
	draw_circle(state.player, state.RADIUS, Color(0.65, 0.75, 1))
	draw_circle(state.player + Vector2(5, -4), 3, Color(0.12, 0.17, 0.3))
	draw_string(font, Vector2(40, 515), "WASD / Arrow keys to move     R to restart", HORIZONTAL_ALIGNMENT_LEFT, -1, 17, Color(0.5, 0.6, 0.73))
	if state.finished():
		draw_style_box(_banner(), Rect2(280, 210, 400, 100))
		draw_string(font, Vector2(315, 270), "All stars found!  Press R", HORIZONTAL_ALIGNMENT_LEFT, -1, 24, Color(0.9, 0.95, 1))

func _banner() -> StyleBoxFlat:
	var style = StyleBoxFlat.new()
	style.bg_color = Color(0.08, 0.13, 0.23, 0.95)
	style.set_corner_radius_all(18)
	return style

func lightmao_observe() -> Dictionary:
	return {"player_x": state.player.x, "player_y": state.player.y, "collected": state.collected, "remaining": state.stars.size(), "finished": state.finished()}

func lightmao_actions() -> Array:
	return [
		{"id":"right","label":"向右移动一小段","key":"RIGHT","frames":18},
		{"id":"left","label":"向左移动一小段","key":"LEFT","frames":18},
		{"id":"up","label":"向上移动一小段","key":"UP","frames":12},
		{"id":"down","label":"向下移动一小段","key":"DOWN","frames":12},
		{"id":"restart","label":"重新开始并恢复初始状态","key":"R","frames":1}
	]
