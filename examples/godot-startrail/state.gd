extends RefCounted

const WORLD_SIZE = Vector2(960, 540)
const SPEED = 240.0
const RADIUS = 16.0
var player = Vector2(120, 270)
var stars: Array[Vector2] = []
var collected = 0

func _init() -> void:
	reset()

func reset() -> void:
	player = Vector2(120, 270)
	stars = [Vector2(260, 220), Vector2(380, 350), Vector2(520, 180), Vector2(670, 330), Vector2(820, 240)]
	collected = 0

func move(direction: Vector2, delta: float) -> void:
	player += direction.limit_length() * SPEED * maxf(delta, 0.0)
	player = player.clamp(Vector2(RADIUS, 90), WORLD_SIZE - Vector2(RADIUS, 60))
	for index in range(stars.size() - 1, -1, -1):
		if player.distance_to(stars[index]) <= RADIUS + 12.0:
			stars.remove_at(index)
			collected += 1

func finished() -> bool:
	return stars.is_empty()
