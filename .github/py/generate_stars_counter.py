import requests
from PIL import Image, ImageDraw, ImageFont
import os
from io import BytesIO

def rounded_rectangle(draw, xy, radius, fill):
    x1, y1, x2, y2 = xy
    diameter = radius * 2
    
    # Отрисовка прямоугольника
    draw.rectangle([x1 + radius, y1, x2 - radius, y2], fill=fill)
    draw.rectangle([x1, y1 + radius, x2, y2 - radius], fill=fill)
    
    # Отрисовка углов
    draw.ellipse([x1, y1, x1 + diameter, y1 + diameter], fill=fill)
    draw.ellipse([x2 - diameter, y1, x2, y1 + diameter], fill=fill)
    draw.ellipse([x1, y2 - diameter, x1 + diameter, y2], fill=fill)
    draw.ellipse([x2 - diameter, y2 - diameter, x2, y2], fill=fill)

# Получение количества звёзд через GitHub API
repo = "RushanM/Minecraft-Mods-Russian-Translation"
headers = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}
response = requests.get(f"https://api.github.com/repos/{repo}", headers=headers)
stars_count = response.json()["stargazers_count"]

# Скачивание шрифта с Google Fonts
font_url = "https://github.com/google/fonts/raw/main/ofl/inter/Inter[opsz,wght].ttf"
font_response = requests.get(font_url)
font = ImageFont.truetype(BytesIO(font_response.content), size=30)

# Создание нового изображения
width = 200
height = 50
image = Image.new('RGBA', (width, height), (255, 255, 255, 0))
draw = ImageDraw.Draw(image)

# Настройка текста
text = f"⭐ {stars_count}"

# Получение размеров текста
text_bbox = draw.textbbox((0, 0), text, font=font)
text_width = text_bbox[2] - text_bbox[0]
text_height = text_bbox[3] - text_bbox[1]
x = (width - text_width) / 2
y = (height - text_height) / 2

# Добавление фона
draw.rounded_rectangle([0, 0, width, height], fill=(45, 45, 45, 230), radius=10)

# Отрисовка текста
draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

# Создание каталога, если его нет
os.makedirs('Ассеты', exist_ok=True)

# Сохранение изображения
image.save('Ассеты/stars-counter.png')