const core = require('@actions/core');
const github = require('@actions/github');
const {
    google
} = require('googleapis');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const execSync = require('child_process').execSync;

// Получение переменных окружения
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// Инициализация клиентов Гитхаба и Гугл-таблиц
const octokit = github.getOctokit(GITHUB_TOKEN);

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({
    version: 'v4',
    auth
});

// Основная функция
(async () => {
    try {
        console.log('Текущий рабочий каталог:', process.cwd());
        console.log('Содержание корневого каталога:', fs.readdirSync('.'));
        console.log('Содержание каталога «Набор ресурсов»:', fs.readdirSync('Набор ресурсов'));

        // 1. Получение списка всех тегов
        const tags = await octokit.paginate(octokit.rest.repos.listTags, {
            ...github.context.repo,
            per_page: 100,
        });

        console.log(`Всего тегов получено: ${tags.length}`);

        // 2. Нахождение последнего альфа-тега
        const lastAlphaTag = getLastAlphaTag(tags);

        console.log(`Последний альфа-тег: ${lastAlphaTag}`);

        // 3. Определение следующего тега
        const nextTagInfo = getNextAlphaTag(lastAlphaTag);

        console.log(`Следующий тег: ${nextTagInfo.tag}`);

        // 4. Получение списка изменённых файлов
        const changedFiles = getChangedFiles(lastAlphaTag);

        console.log(`Изменённые файлы:\n${changedFiles.map(f => `${f.status}\t${f.filePath}`).join('\n')}`);

        // 5. Обработка изменений и формирование описания выпуска
        const releaseNotes = await generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastAlphaTag);

        console.log(`Описание выпуска:\n${releaseNotes}`);

        // 6. Создание архивов
        const assets = createArchives(changedFiles, nextTagInfo);

        // 7. Создание выпуск на Гитхабе
        await createRelease(nextTagInfo, releaseNotes, assets);

        console.log('Выпуск успешно создан.');
    } catch (error) {
        core.setFailed(error.message);
    }
})();

// Функция для получения последнего альфа-тега
function getLastAlphaTag(tags) {
    const alphaTags = tags.filter(tag => /^(?:dev\d+|\d+-C\d+-B\d+-A\d+)$/.test(tag.name));
    if (alphaTags.length === 0) return null;
    // Сортировка по версии
    alphaTags.sort((a, b) => {
        const versionA = getAlphaVersionNumber(a.name);
        const versionB = getAlphaVersionNumber(b.name);
        return versionB - versionA;
    });
    return alphaTags[0].name;
}

// Функция для получения номера альфа-версии из тега
function getAlphaVersionNumber(tag) {
    const devMatch = tag.match(/^dev(\d+)$/);
    if (devMatch) return parseInt(devMatch[1]);

    const tagMatch = tag.match(/^(\d+)-C(\d+)-B(\d+)-A(\d+)$/);
    if (tagMatch) {
        const releaseNum = parseInt(tagMatch[1]);
        const candidateNum = parseInt(tagMatch[2]);
        const betaNum = parseInt(tagMatch[3]);
        const alphaNum = parseInt(tagMatch[4]);
        // Считаем общий номер версии для сортировки
        return ((releaseNum * 1000000) + (candidateNum * 10000) + (betaNum * 100) + alphaNum);
    }

    return 0;
}

// Функция для определения следующего тега
function getNextAlphaTag(lastTag) {
    let releaseNum = 1;
    let candidateNum = 1;
    let betaNum = 1;
    let alphaNum = 1;

    if (lastTag) {
        const devMatch = lastTag.match(/^dev(\d+)$/);
        const tagMatch = lastTag.match(/^(\d+)-C(\d+)-B(\d+)-A(\d+)$/);

        if (devMatch) {
            alphaNum = parseInt(devMatch[1]) + 1;
        } else if (tagMatch) {
            releaseNum = parseInt(tagMatch[1]);
            candidateNum = parseInt(tagMatch[2]);
            betaNum = parseInt(tagMatch[3]);
            alphaNum = parseInt(tagMatch[4]) + 1;
        }
    }

    const newTag = `${releaseNum}-C${candidateNum}-B${betaNum}-A${alphaNum}`;
    const title = `${alphaNum}-я альфа`;

    return {
        tag: newTag,
        title,
        releaseNum,
        candidateNum,
        betaNum,
        alphaNum
    };
}

// Функция для получения списка изменённых файлов
function getChangedFiles(lastTag) {
    let diffCommand = 'git diff --name-status';
    if (lastTag) {
        diffCommand += ` ${lastTag} HEAD`;
    } else {
        // Если нет предыдущего тега, получаем изменения в последнем коммите
        diffCommand += ` HEAD~1 HEAD`;
    }

    const diffOutput = execSync(diffCommand).toString();
    const changedFiles = diffOutput.trim().split('\n').map(line => {
        const [status, ...fileParts] = line.split('\t');
        const filePath = fileParts.join('\t');
        return {
            status,
            filePath
        };
    });

    return changedFiles;
}

// Функция для генерации описания выпуска
async function generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag) {
    let description = `Это ${nextTagInfo.alphaNum}-я альфа-версия всех переводов проекта.\n\n`;

    if (lastTag && /^dev\d+$/.test(lastTag)) {
        description += `Пререлизы были упразднены! Теперь пререлизы зовутся альфами. Про то, как теперь выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/alpha/Памятки/Именование%20выпусков.md).\n\n`;
    } else {
        description += `Про то, как выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/alpha/Памятки/Именование%20выпусков.md).\n\n`;
    }

    const modChanges = await getModChanges(changedFiles, sheets);

    if (modChanges.length === 1) {
        const change = modChanges[0];
        description += `В этой альфа-версии ${change.action} перевод мода [${change.name}](${change.url}) на Minecraft ${change.gameVer}.`;
    } else if (modChanges.length > 1) {
        description += `Изменения в этой версии:\n`;
        modChanges.forEach(change => {
            description += `* ${change.action} перевод мода [${change.name}](${change.url}) на Minecraft ${change.gameVer};\n`;
        });
    }

    return description.trim();
}

// Функция для получения информации об изменениях модов
async function getModChanges(changedFiles, sheets) {
    const modChanges = [];

    for (const file of changedFiles) {
        if (/^Набор ресурсов\/[^/]+\/assets\/[^/]+\/lang\/ru_ru\.json$/.test(file.filePath)) {
            const parts = file.filePath.split('/');
            const gameVer = parts[1];
            const modId = parts[3];

            const action = file.status.startsWith('A') ? 'Добавлен' : 'Изменён';

            const modInfo = await getModInfoFromSheet(modId, gameVer, sheets);

            if (modInfo) {
                modChanges.push({
                    action,
                    name: modInfo.name,
                    url: modInfo.url,
                    gameVer,
                });
            }
        }
    }

    return modChanges;
}

// Функция для получения информации о моде из Гугл-таблиц
async function getModInfoFromSheet(modId, gameVer, sheets) {
    const spreadsheetId = '1kGGT2GGdG_Ed13gQfn01tDq2MZlVOC9AoiD1s3SDlZE';
    const range = 'db!A1:Z1000';

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    const rows = response.data.values;
    const headers = rows[0];
    const idIndex = headers.indexOf('id');
    const gameVerIndex = headers.indexOf('gameVer');
    const nameIndex = headers.indexOf('name');
    const modrinthUrlIndex = headers.indexOf('modrinthUrl');
    const cfUrlIndex = headers.indexOf('cfUrl');
    const fallbackUrlIndex = headers.indexOf('fallbackUrl');

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if (row[idIndex] === modId && row[gameVerIndex] === gameVer) {
            const name = row[nameIndex];
            const modrinthUrl = row[modrinthUrlIndex];
            const cfUrl = row[cfUrlIndex];
            const fallbackUrl = row[fallbackUrlIndex];

            const url = modrinthUrl || cfUrl || fallbackUrl || '';

            return {
                name,
                url
            };
        }
    }

    return null;
}

/// Функция для создания архивов
function createArchives(changedFiles, nextTagInfo) {
    const assets = [];

    // Определение пути к releases на основе текущего рабочего каталога
    const releasesDir = path.join(process.cwd(), 'releases');
    if (!fs.existsSync(releasesDir)) {
        fs.mkdirSync(releasesDir, {
            recursive: true
        });
    }

    // Создание архивов для наборов ресурсов
    const resourcePackDir = 'Набор ресурсов';
    if (fs.existsSync(resourcePackDir)) {
        const resourcePackVersions = fs.readdirSync(resourcePackDir).filter(ver => {
            return fs.statSync(path.join(resourcePackDir, ver)).isDirectory();
        });

        resourcePackVersions.forEach(ver => {
            const archiveName = `Rus-For-Mods-${ver}-${nextTagInfo.tag}.zip`;
            const outputPath = path.join(releasesDir, archiveName);

            const zip = new AdmZip();

            const versionDir = path.join('Набор ресурсов', ver);

            // Добавление папки assets
            const assetsPath = path.join(versionDir, 'assets');
            if (fs.existsSync(assetsPath)) {
                zip.addLocalFolder(assetsPath, 'assets');
            }

            // Добавление файлов из папки версии
            ['pack.mcmeta', 'dynamicmcpack.json', 'respackopts.json5'].forEach(fileName => {
                const filePath = path.join(versionDir, fileName);
                if (fs.existsSync(filePath)) {
                    zip.addLocalFile(filePath, '', fileName);
                }
            });

            zip.addLocalFile('Набор ресурсов/pack.png');
            zip.addLocalFile('Набор ресурсов/peruse_or_bruise.txt');
            zip.writeZip(outputPath);

            console.log(`Создан архив: ${outputPath}`);

            assets.push({
                path: outputPath,
                name: archiveName
            });
        });
    }

    // Создание архивов для наборов шейдеров
    const shaderPacksDir = 'Наборы шейдеров';
    if (fs.existsSync(shaderPacksDir)) {
        const shaderPacks = fs.readdirSync(shaderPacksDir).filter(pack => {
            return fs.statSync(path.join(shaderPacksDir, pack)).isDirectory();
        });

        shaderPacks.forEach(pack => {
            // Преобразование название папки в формат названия файла
            const archiveName = `${pack.replace(/\s+/g, '-')}-Russian-Translation-${nextTagInfo.tag}.zip`;
            const outputPath = path.join(releasesDir, archiveName);

            const zip = new AdmZip();

            zip.addLocalFolder(path.join(shaderPacksDir, pack));
            zip.writeZip(outputPath);

            console.log(`Создан архив: ${outputPath}`);

            assets.push({
                path: outputPath,
                name: archiveName
            });
        });
    }

    // Создание архивов для сборок
    const modpacksDir = 'Сборки';
    if (fs.existsSync(modpacksDir)) {
        const modpacks = fs.readdirSync(modpacksDir).filter(modpack => {
            const translationPath = path.join(modpacksDir, modpack, 'Перевод');
            return fs.existsSync(translationPath) && fs.statSync(translationPath).isDirectory();
        });

        modpacks.forEach(modpack => {
            const translationPath = path.join(modpacksDir, modpack, 'Перевод');

            // Преобразование названия сборки в формат названия файла
            const archiveName = `${modpack.replace(/\s+/g, '-')}-Russian-Translation-${nextTagInfo.tag}.zip`;
            const outputPath = path.join(releasesDir, archiveName);

            const zip = new AdmZip();

            zip.addLocalFolder(translationPath);
            zip.writeZip(outputPath);

            console.log(`Создан архив: ${outputPath}`);

            assets.push({
                path: outputPath,
                name: archiveName
            });
        });
    }

    return assets;
}

// Функция для создания выпуска на Гитхабе
async function createRelease(tagInfo, releaseNotes, assets) {
    const releaseResponse = await octokit.rest.repos.createRelease({
        ...github.context.repo,
        tag_name: tagInfo.tag,
        target_commitish: github.context.sha,
        name: tagInfo.title,
        body: releaseNotes,
        draft: false,
        prerelease: true,
    });

    const uploadUrl = releaseResponse.data.upload_url;

    for (const asset of assets) {
        const content = fs.readFileSync(asset.path);
        await octokit.rest.repos.uploadReleaseAsset({
            url: uploadUrl,
            headers: {
                'content-type': 'application/zip',
                'content-length': content.length,
            },
            name: asset.name,
            data: content,
        });
        console.log(`Загружен ассет: ${asset.name}`);
    }
}