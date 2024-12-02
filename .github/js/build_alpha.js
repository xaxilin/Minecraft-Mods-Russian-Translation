const core = require('@actions/core');
const github = require('@actions/github');
const {
    google
} = require('googleapis');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const execSync = require('child_process').execSync;
const semver = require('semver');

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

        // 2. Нахождение последнего тега (альфа или бета)
        const lastTag = getLastVersionTag(tags);

        console.log(`Последний тег: ${lastTag}`);

        // 3. Определение следующего тега
        const nextTagInfo = getNextAlphaTag(lastTag);

        console.log(`Следующий тег: ${nextTagInfo.tag}`);

        // 4. Получение списка изменённых файлов
        const changedFiles = getChangedFiles(lastTag);

        console.log(`Изменённые файлы:\n${changedFiles.map(f => `${f.status}\t${f.filePath}`).join('\n')}`);

        // 5. Обработка изменений и формирование описания выпуска
        const releaseNotes = await generateReleaseNotes(changedFiles, sheets, nextTagInfo, lastTag);

        console.log(`Описание выпуска:\n${releaseNotes}`);

        // 6. Получение версий архивов из предыдущего выпуска
        const previousAssetVersions = await getPreviousAssetVersions(lastTag);

        // 7. Создание архивов
        const assets = createArchives(changedFiles, nextTagInfo, previousAssetVersions, lastTag);
        console.log('Сгенерированные assets:', assets);

        // 8. Создание выпуска на Гитхабе
        await createRelease(nextTagInfo, releaseNotes, assets);

        console.log('Выпуск успешно создан.');
    } catch (error) {
        core.setFailed(error.message);
    }
})();

// Функция для получения последнего тега (альфа или бета)
function getLastVersionTag(tags) {
    const versionTags = tags.filter(tag => /^(?:dev\d+|\d+-C\d+-B\d+(?:-A\d+)?)$/.test(tag.name));
    if (versionTags.length === 0) return null;
    // Сортировка по версии
    versionTags.sort((a, b) => {
        const versionA = getVersionNumber(a.name);
        const versionB = getVersionNumber(b.name);
        return versionB - versionA;
    });
    return versionTags[0].name;
}

// Функция для получения номера версии из тега
function getVersionNumber(tag) {
    const devMatch = tag.match(/^dev(\d+)$/);
    if (devMatch) return parseInt(devMatch[1]);

    const tagMatch = tag.match(/^(\d+)-C(\d+)-B(\d+)(?:-A(\d+))?$/);
    if (tagMatch) {
        const releaseNum = parseInt(tagMatch[1]);
        const candidateNum = parseInt(tagMatch[2]);
        const betaNum = parseInt(tagMatch[3]);
        const alphaNum = tagMatch[4] ? parseInt(tagMatch[4]) : 0;
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
        const tagMatch = lastTag.match(/^(\d+)-C(\d+)-B(\d+)(?:-A(\d+))?$/);

        if (devMatch) {
            alphaNum = parseInt(devMatch[1]) + 1;
        } else if (tagMatch) {
            releaseNum = parseInt(tagMatch[1]);
            candidateNum = parseInt(tagMatch[2]);
            betaNum = parseInt(tagMatch[3]);

            if (tagMatch[4]) {
                // Если последний тег был альфа-версией, увеличиваем номер альфы
                alphaNum = parseInt(tagMatch[4]) + 1;
            } else {
                // Если последний тег был бета-версией, увеличиваем номер беты и сбрасываем номер альфы
                betaNum += 1;
                alphaNum = 1;
            }
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

// Функция для получения версий архивов из предыдущего выпуска
async function getPreviousAssetVersions(lastTag) {
    if (!lastTag) {
        return {}; // Если нет предыдущего тега, возвращаем пустой объект
    }

    const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
        ...github.context.repo,
        per_page: 100,
    });

    const lastRelease = releases.find(release => release.tag_name === lastTag);

    const versions = {};

    if (lastRelease) {
        if (lastRelease.assets && lastRelease.assets.length > 0) {
            lastRelease.assets.forEach(asset => {
                // Извлечение версии из названия файла
                const match = asset.name.match(/^(.*?)-((?:dev\d+|\d+-C\d+-B\d+-A\d+))\.zip$/);
                if (match) {
                    const baseName = match[1];
                    const version = match[2];
                    versions[baseName] = version;
                }
            });
        }
    }

    console.log('Предыдущие версии архивов:', versions);

    return versions;
}

// Функция для создания архивов с учётом версий файлов
async function createArchives(changedFiles, nextTagInfo, previousAssetVersions, lastTag) {
    const assets = [];
    try {
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

            for (const ver of resourcePackVersions) {
                const gameVersion = ver;
                const baseNamePrefix = `Rus-For-Mods-${gameVersion}-`;

                // Получаем последнюю релизную версию для этого игрового набора ресурсов
                const lastReleaseVersion = await getLastResourcePackReleaseVersion(gameVersion) || '1.0';

                // Проверяем предыдущие версии ассетов
                let prevVersion = previousAssetVersions[`${baseNamePrefix}${lastReleaseVersion}`];

                // Проверка, изменились ли файлы в этой версии
                const versionDir = path.join('Набор ресурсов', ver);
                const relatedFiles = changedFiles.filter(file => file.filePath.startsWith(versionDir));

                let assetVersion;

                // Формирование новой версии
                if (prevVersion) {
                    const prevVersionParts = prevVersion.split('-');
                    const prevAlphaPart = prevVersionParts[prevVersionParts.length - 1];
                    const alphaMatch = prevAlphaPart.match(/^A(\d+)$/);
                    let newAlphaNumber = nextTagInfo.alphaNum;

                    if (alphaMatch) {
                        if (relatedFiles.length > 0) {
                            // Увеличиваем номер альфы
                            newAlphaNumber = parseInt(alphaMatch[1]) + 1;
                        } else {
                            // Оставляем предыдущую версию
                            newAlphaNumber = parseInt(alphaMatch[1]);
                        }
                    }

                    assetVersion = `${lastReleaseVersion}-C${nextTagInfo.candidateNum}-B${nextTagInfo.betaNum}-A${newAlphaNumber}`;
                } else {
                    // Если нет предыдущей альфа-версии после релиза, начинаем новую альфу с A1
                    assetVersion = `${lastReleaseVersion}-C1-B1-A1`;
                }

                const archiveName = `${baseNamePrefix}${assetVersion}.zip`;
                const outputPath = path.join(releasesDir, archiveName);

                const zip = new AdmZip();

                // Добавление содержимого архива
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

                // Добавление общих файлов
                zip.addLocalFile('Набор ресурсов/pack.png');
                zip.addLocalFile('Набор ресурсов/peruse_or_bruise.txt');
                zip.writeZip(outputPath);

                console.log(`Создан архив: ${outputPath}`);

                assets.push({
                    path: outputPath,
                    name: archiveName
                });
            }
        }

        // Создание архивов для наборов шейдеров
        const shaderPacksDir = 'Наборы шейдеров';
        if (fs.existsSync(shaderPacksDir)) {
            const shaderPacks = fs.readdirSync(shaderPacksDir).filter(pack => {
                return fs.statSync(path.join(shaderPacksDir, pack)).isDirectory();
            });

            shaderPacks.forEach(pack => {
                const baseName = `${pack.replace(/\s+/g, '-')}-Russian-Translation`;
                let prevVersion = previousAssetVersions[baseName];

                // Проверка, изменились ли файлы в этом наборе шейдеров
                const packDir = path.join(shaderPacksDir, pack);
                const relatedFiles = changedFiles.filter(file => file.filePath.startsWith(packDir));

                let assetVersion;

                if (prevVersion) {
                    // Извлечение номера предыдущей версии
                    const prevVersionNumber = getAssetVersionNumber(prevVersion);

                    if (relatedFiles.length > 0) {
                        // Увеличение версии
                        assetVersion = incrementAssetVersion(prevVersionNumber);
                    } else {
                        // Оставляем версию прежней
                        assetVersion = prevVersionNumber;
                    }
                } else {
                    // Если нет предыдущей версии, начинаем с 1-й альфы или используем версию из dev
                    if (lastTag && lastTag.startsWith('dev')) {
                        const devNumber = parseInt(lastTag.slice(3));
                        assetVersion = `1-C1-B1-A${devNumber}`;
                    } else {
                        assetVersion = nextTagInfo.tag;
                    }
                }

                const archiveName = `${baseName}-${assetVersion}.zip`;
                const outputPath = path.join(releasesDir, archiveName);

                const zip = new AdmZip();

                zip.addLocalFolder(packDir);
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
                const baseName = `${modpack.replace(/\s+/g, '-')}-Russian-Translation`;
                let prevVersion = previousAssetVersions[baseName];

                // Проверка, изменились ли файлы в этой сборке
                const packDir = path.join(modpacksDir, modpack);
                const relatedFiles = changedFiles.filter(file => file.filePath.startsWith(packDir));

                let assetVersion;

                if (prevVersion) {
                    // Извлечение номера предыдущей версии
                    const prevVersionNumber = getAssetVersionNumber(prevVersion);

                    if (relatedFiles.length > 0) {
                        // Увеличение версии
                        assetVersion = incrementAssetVersion(prevVersionNumber);
                    } else {
                        // Оставляем версию прежней
                        assetVersion = prevVersionNumber;
                    }
                } else {
                    // Если нет предыдущей версии, начинаем с 1-й альфы или используем версию из dev
                    if (lastTag && lastTag.startsWith('dev')) {
                        const devNumber = parseInt(lastTag.slice(3));
                        assetVersion = `1-C1-B1-A${devNumber}`;
                    } else {
                        assetVersion = nextTagInfo.tag;
                    }
                }

                const archiveName = `${baseName}-${assetVersion}.zip`;
                const outputPath = path.join(releasesDir, archiveName);

                const zip = new AdmZip();

                zip.addLocalFolder(path.join(modpacksDir, modpack, 'Перевод'));
                zip.writeZip(outputPath);

                console.log(`Создан архив: ${outputPath}`);

                assets.push({
                    path: outputPath,
                    name: archiveName
                });
            });
        }
    } catch (error) {
        console.error('Ошибка в createArchives:', error);
    }
    return assets;
}

// Функция для извлечения номера версии из названия архива
function getAssetVersionNumber(version) {
    if (version.startsWith('dev')) {
        return version.replace('dev', '1-C1-B1-A');
    }
    return version;
}

// Функция для увеличения версии
function incrementAssetVersion(version) {
    const match = version.match(/^(\d+)-C(\d+)-B(\d+)-A(\d+)$/);
    if (match) {
        const releaseNum = parseInt(match[1]);
        const candidateNum = parseInt(match[2]);
        const betaNum = parseInt(match[3]);
        const alphaNum = parseInt(match[4]) + 1;
        return `${releaseNum}-C${candidateNum}-B${betaNum}-A${alphaNum}`;
    }
    return version; // Если формат не соответствует, возвращаем исходную версию
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

// Получение последней релизной версии набора ресурсов для определённой версии игры
async function getLastResourcePackReleaseVersion(gameVersion) {
    const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
        ...github.context.repo,
        per_page: 100,
    });

    // Фильтрование релизов, которые содержат набор ресурсов для указанной версии игры и являются полноценными релизами
    const resourcePackReleases = releases.filter(release => !release.prerelease && release.assets.some(asset => {
        const assetMatch = asset.name.match(new RegExp(`^Rus-For-Mods-${gameVersion}-(\\d+\\.\\d+)\\.zip$`));
        return assetMatch;
    }));

    if (resourcePackReleases.length === 0) {
        return null;
    }

    // Нахождение последнего релиза по дате
    resourcePackReleases.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    // Извлечение версии из названия ассета
    for (const release of resourcePackReleases) {
        const latestAsset = release.assets.find(asset => asset.name.startsWith(`Rus-For-Mods-${gameVersion}-`));
        if (latestAsset) {
            const versionMatch = latestAsset.name.match(new RegExp(`^Rus-For-Mods-${gameVersion}-(\\d+\\.\\d+)\\.zip$`));
            if (versionMatch) {
                return versionMatch[1]; // Возвращение версии
            }
        }
    }

    return null;
}