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

        // 2. Получение последнего выпуска
        const lastRelease = await getLastRelease(octokit, github.context.repo);
        console.log(`Последний выпуск: ${lastRelease ? lastRelease.tag_name : 'Нет выпусков'}`);

        // 3. Парсинг версий из ассетов последнего выпуска
        const fileVersions = {};
        if (lastRelease && lastRelease.assets) {
            lastRelease.assets.forEach(asset => {
                const version = parseVersion(asset.name);
                if (version) {
                    // Извлечение gameVer из названия файла
                    const match = asset.name.match(/Rus-For-Mods-(\d+\.\d+)-\d+-C\d+-B\d+-A\d+\.zip$/);
                    if (match) {
                        const gameVer = match[1];
                        fileVersions[gameVer] = version;
                    }
                }
            });
        }
        console.log('Текущие версии файлов:', fileVersions);

        // 4. Определение следующего тега
        const nextTagInfo = getNextAlphaTagFromLastRelease(fileVersions);
        console.log(`Следующий тег: ${nextTagInfo.tag}`);

        // 5. Получение списка изменённых файлов
        const changedFiles = getChangedFiles(lastRelease ? lastRelease.tag_name : null);

        console.log(`Изменённые файлы:\n${changedFiles.map(f => `${f.status}\t${f.filePath}`).join('\n')}`);

        // 6. Обработка изменений и формирование описания выпуска
        const releaseNotes = await generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastRelease ? lastRelease.tag_name : null);

        console.log(`Описание выпуска:\n${releaseNotes}`);

        // 7. Создание архивов
        const assets = createArchives(changedFiles, nextTagInfo, fileVersions);

        // 8. Создание выпуска на Гитхабе
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
    let diffCommand = 'git -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8 diff --name-status';
    if (lastTag) {
        diffCommand += ` ${lastTag} HEAD`;
    } else {
        // Если нет предыдущего тега, получаем изменения в последнем коммите
        diffCommand += ` HEAD~1 HEAD`;
    }

    const diffOutput = execSync(diffCommand, {
        encoding: 'utf8'
    });
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

// Функция для получения информации об изменениях модов
async function getModChanges(changedFiles, sheets) {
    const modChanges = [];
    const newGameVersions = [];

    console.log('Обработанные файлы:', changedFiles);

    for (const file of changedFiles) {
        const decodedFilePath = file.filePath;
        console.log('Проверка файла:', decodedFilePath);

        // Проверка на добавление pack.mcmeta
        const packMcmetaMatch = decodedFilePath.match(/^Набор ресурсов\/([^/]+)\/pack\.mcmeta$/);
        if (packMcmetaMatch && file.status.startsWith('A')) {
            const gameVer = packMcmetaMatch[1];
            newGameVersions.push(gameVer);
            console.log(`Добавлен pack.mcmeta для версии ${gameVer}`);
            continue; // Переход к следующему файлу
        }

        // Проверка на языковые файлы модов
        if (/^Набор ресурсов\/[^/]+\/assets\/[^/]+\/lang\/ru_(RU|ru)\.(json|lang)$/.test(decodedFilePath)) {
            console.log('Файл соответствует шаблону:', decodedFilePath);

            const parts = decodedFilePath.split('/');
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
        } else {
            console.log('Файл не соответствует шаблону:', decodedFilePath);
        }
    }

    const uniqueGameVersions = [...new Set(newGameVersions)];

    console.log('Изменения в файлах:', modChanges);
    console.log('Новые затронутые версии Minecraft:', uniqueGameVersions);
    return {
        modChanges,
        newGameVersions: uniqueGameVersions
    };
}

// Функция для генерации описания выпуска
async function generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag) {
    let description = `Это ${nextTagInfo.alphaNum}-я альфа-версия всех переводов проекта.\n\n`;

    if (lastTag && /^dev\d+$/.test(lastTag)) {
        description += `Пререлизы были упразднены! Теперь пререлизы зовутся альфами. Про то, как теперь выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/alpha/Руководство/Именование%20выпусков.md).\n\n`;
    } else {
        description += `Про то, как выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/alpha/Руководство/Именование%20выпусков.md).\n\n`;
    }

    const {
        modChanges,
        newGameVersions
    } = await getModChanges(changedFiles, sheets);


    // Формирование общего списка изменений
    const allChanges = [];

    // Добавление текста о новой поддерживаемой версии Minecraft
    newGameVersions.forEach(gameVer => {
        allChanges.push(`Начат перевод модов для Minecraft ${gameVer}.x`);
    });

    // Добавление текста об изменениях в модах
    modChanges.forEach(change => {
        if (allChanges.length === 0 && modChanges.length === 1) {
            // Если только одно изменение, не используем список
            const actionLower = change.action.charAt(0).toLowerCase() + change.action.slice(1);
            const gameVersionWithX = change.gameVer + '.x';
            allChanges.push(`В этой альфа-версии ${actionLower} перевод мода [${change.name}](${change.url}) на Minecraft ${gameVersionWithX}.`);
        } else {
            // Используем списки с пунктами
            const gameVersionWithX = change.gameVer + '.x';
            allChanges.push(`${change.action} перевод мода [${change.name}](${change.url}) на Minecraft ${gameVersionWithX}`);
        }
    });

    if (allChanges.length === 1) {
        description += `${allChanges[0]}`;
    } else if (allChanges.length > 1) {
        description += `Изменения в этой версии:\n`;
        allChanges.forEach((change, index) => {
            const separator = index === allChanges.length - 1 ? '.' : ';';
            description += `* ${change}${separator}\n`;
        });
    }

    return description.trim();
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
function createArchives(changedFiles, nextTagInfo, fileVersions) {
    const assets = [];

    const releasesDir = path.join(process.cwd(), 'releases');
    if (!fs.existsSync(releasesDir)) {
        fs.mkdirSync(releasesDir, {
            recursive: true
        });
    }

    const directories = [{
            dir: 'Набор ресурсов',
            type: 'resourcePack'
        },
        {
            dir: 'Наборы шейдеров',
            type: 'shaderPack'
        },
        {
            dir: 'Сборки',
            type: 'modpack'
        }
    ];

    directories.forEach(directory => {
        if (fs.existsSync(directory.dir)) {
            const items = fs.readdirSync(directory.dir).filter(item => {
                return fs.statSync(path.join(directory.dir, item)).isDirectory();
            });

            items.forEach(item => {
                const translationPath = directory.type === 'modpack' ? path.join(directory.dir, item, 'Перевод') : path.join(directory.dir, item);
                if (directory.type === 'modpack' && !fs.existsSync(translationPath)) return;

                // Определение gameVer из названия папки
                const gameVerMatch = item.match(/\d+\.\d+/);
                const gameVer = gameVerMatch ? gameVerMatch[0] : '1.0';

                // Получение текущей версии файла
                let currentVersion = fileVersions[gameVer] || '1-C1-B1-A1';

                // Проверка, изменён ли файл
                const isChanged = changedFiles.some(file => file.filePath.includes(directory.dir) && file.filePath.includes(item));

                if (isChanged) {
                    currentVersion = incrementVersion(currentVersion);
                    fileVersions[gameVer] = currentVersion;
                }

                // Формирование названия архива
                const archiveName = `Rus-For-Mods-${gameVer}-${currentVersion}.zip`;
                const outputPath = path.join(releasesDir, archiveName);
                const zip = new AdmZip();

                if (directory.type === 'resourcePack') {
                    const assetsPath = path.join(directory.dir, item, 'assets');
                    if (fs.existsSync(assetsPath)) {
                        zip.addLocalFolder(assetsPath, 'assets');
                    }
                    ['pack.mcmeta', 'dynamicmcpack.json', 'respackopts.json5'].forEach(fileName => {
                        const filePath = path.join(directory.dir, item, fileName);
                        if (fs.existsSync(filePath)) {
                            zip.addLocalFile(filePath, '', fileName);
                        }
                    });
                    zip.addLocalFile(path.join(directory.dir, 'pack.png'));
                    zip.addLocalFile(path.join(directory.dir, 'peruse_or_bruise.txt'));
                } else if (directory.type === 'shaderPack') {
                    zip.addLocalFolder(path.join(directory.dir, item));
                } else if (directory.type === 'modpack') {
                    zip.addLocalFolder(translationPath);
                }

                zip.writeZip(outputPath);
                console.log(`Создан архив: ${outputPath}`);

                assets.push({
                    path: outputPath,
                    name: archiveName
                });
            });
        }
    });

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

// Функция для получения последнего релиза
async function getLastRelease(octokit, repo) {
    const releases = await octokit.rest.repos.listReleases({
        owner: repo.owner,
        repo: repo.repo,
        per_page: 1,
        page: 1,
    });
    return releases.data[0];
}

// Функция для извлечения версии из названия файла
function parseVersion(fileName) {
    const regex = /Rus-For-Mods-\d+\.\d+-(\d+-C\d+-B\d+-A\d+)\.zip$/;
    const match = fileName.match(regex);
    if (match) {
        return match[1]; // Возвращает часть версии, например, «1-C1-B1-A224»
    }
    return null;
}

// Функция для инкрементирования версии
function incrementVersion(version) {
    const parts = version.split('-A');
    if (parts.length !== 2) return '1-C1-B1-A1';
    const alphaNum = parseInt(parts[1]) + 1;
    return `${parts[0]}-A${alphaNum}`;
}

// Функция для определения следующего тега на основе текущих версий файлов
function getNextAlphaTagFromLastRelease(fileVersions) {
    let maxAlpha = 0;
    for (const version of Object.values(fileVersions)) {
        const alphaMatch = version.match(/-A(\d+)$/);
        if (alphaMatch) {
            const alphaNum = parseInt(alphaMatch[1]);
            if (alphaNum > maxAlpha) {
                maxAlpha = alphaNum;
            }
        }
    }
    const newAlpha = maxAlpha + 1;
    const newTag = `1-C1-B1-A${newAlpha}`;
    const title = `${newAlpha}-я альфа`;

    return {
        tag: newTag,
        title,
        releaseNum: 1,
        candidateNum: 1,
        betaNum: 1,
        alphaNum: newAlpha
    };
}