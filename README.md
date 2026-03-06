# VclouD Admin Server — Railway деплой

## Як задеплоїти на Railway (безкоштовно)

1. Зайди на https://railway.app і залогінься через GitHub
2. New Project → Deploy from GitHub repo → вибери `vcloud-catalog`
3. Railway сам знайде папку `server/` і задеплоїть

## Змінні середовища (Settings → Variables)

| Змінна | Значення |
|--------|----------|
| `NETLIFY_TOKEN` | nfp_GPCvnA6PeAjzymTNxBYTsxA2MdQaWqqXe76d |
| `NETLIFY_SITE_ID` | ab69a37c-34ed-4404-bb79-b34506bd093e |
| `ADMIN_PASSWORD` | (придумай свій пароль) |

## Після деплою

Отримаєш посилання типу: `https://vcloud-admin.railway.app`

Це і є адмін панель — поділися нею з людиною яка буде додавати товари.
