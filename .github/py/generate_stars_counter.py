import requests
from PIL import Image, ImageDraw, ImageFont
import os
from io import BytesIO

# Получаем количество звёзд через GitHub API
repo = "RushanM/Minecraft-Mods-Russian-Translation"
headers = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}
response = requests.get(f"https://api.github.com/repos/{repo}", headers=headers)
stars_count = response.json()["stargazers_count"]

# Скачиваем шрифт с Google Fonts (например, Roboto)
font_url = "https://github.com/google/fonts/raw/main/ofl/inter/Inter[opsz,wght].ttf"
font_response = requests.get(font_url)
font = ImageFont.truetype(BytesIO(font_response.content), size=30)

# Создаём новое изображение
width = 200
height = 50
image = Image.new('RGBA', (width, height), (255, 255, 255, 0))
draw = ImageDraw.Draw(image)

# Настраиваем текст
text = f"⭐ {stars_count}"

# Получаем размеры текста
text_bbox = draw.textbbox((0, 0), text, font=font)
text_width = text_bbox[2] - text_bbox[0]
text_height = text_bbox[3] - text_bbox[1]
x = (width - text_width) / 2
y = (height - text_height) / 2

# Добавляем красивый фон
draw.rectangle([0, 0, width, height], fill=(45, 45, 45, 230), radius=10)

# Рисуем текст
draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

# Создаём директорию если её нет
os.makedirs('Ассеты', exist_ok=True)

# Сохраняем изображение
image.save('Ассеты/stars-counter.png')