const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { validate: validateUUID } = require('uuid');
const app = express();
app.use(express.json());

require('dotenv').config();

// Configuração do banco de dados
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco:', err.message);
  } else {
    console.log('Conectado ao SQLite');

    // Todas operações do banco dentro de serialize
    db.serialize(() => {
      // 1. Criação da tabela banks
      db.run(`
        CREATE TABLE IF NOT EXISTS banks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          api_key TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 2. Criação da tabela pix_records
      db.run(`
        CREATE TABLE IF NOT EXISTS pix_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pix_type TEXT NOT NULL,
          pix_value TEXT NOT NULL,
          nome TEXT NOT NULL,
          cpf TEXT NOT NULL,
          banco TEXT NOT NULL,
          agencia TEXT NOT NULL,
          conta TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(pix_type, pix_value)
        )
      `, function(err) {
        if (err) {
          console.error('Erro ao criar tabela pix_records:', err.message);
        } else {
          console.log('Tabela pix_records criada');
        }
      });

      // 3. Inserção do banco exemplo usando a chave do .env
      const DEFAULT_API_KEY = process.env.X_API_KEY;
      
      if (!DEFAULT_API_KEY) {
        console.error('Erro: X_API_KEY não definida no .env');
        process.exit(1);
      }

      db.run(`
        INSERT INTO banks (name, api_key)
        SELECT 'Banco Exemplo', ?
        WHERE NOT EXISTS (
          SELECT 1 FROM banks WHERE api_key = ?
        )
      `, [DEFAULT_API_KEY, DEFAULT_API_KEY], function(err) {
        if (err) {
          console.error('Erro ao inserir banco padrão:', err.message);
        } else if (this.changes > 0) {
          console.log(`Banco padrão criado com API Key: ${DEFAULT_API_KEY}`);
        } else {
          console.log('Banco padrão já existente');
        }
      });
    });
  }
});

// Funções de validação
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validatePhone = (phone) => /^\d{11}$/.test(phone);
const validateCPF = (cpf) => /^\d{11}$/.test(cpf);
const validateCNPJ = (cnpj) => /^\d{14}$/.test(cnpj);

// Middleware de autenticação simplificado
const authenticateApiKey = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'API Key não fornecida' });
  }

  try {
    // Verificar no banco de dados
    const bank = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM banks WHERE api_key = ?', [apiKey], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (!bank) {
      return res.status(403).json({ error: 'API Key inválida' });
    }

    // Adicionar ID do banco à requisição para uso posterior
    req.bankId = bank.id;
    next();
  } catch (err) {
    console.error('Erro na autenticação:', err);
    res.status(500).json({ error: 'Erro interno na autenticação' });
  }
};

app.use(['/record', '/register'], authenticateApiKey);

// Rota para buscar um registro específico por tipo e valor
app.get('/record/:type/:value', (req, res) => {
  const { type, value } = req.params;

  const sql = `SELECT * FROM pix_records WHERE pix_type = ? AND pix_value = ?`;

  db.get(sql, [type, value], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Registro não encontrado' });

    res.json({
      id: row.id,
      accountInfo: {
        nome: row.nome,
        cpf: row.cpf,
        banco: row.banco,
        agencia: row.agencia,
        conta: row.conta
      },
      pixInfo: {
        type: row.pix_type,
        value: row.pix_value
      },
      created_at: row.created_at
    });
  });
});

// Rota única para registro
app.post('/register', (req, res) => {
  const { accountInfo, pixInfo } = req.body;

  // Verificar estrutura dos dados
  if (!accountInfo || !pixInfo) {
    return res.status(400).json({ error: 'Estrutura de dados inválida. Use {accountInfo: {...}, pixInfo: {...}}' });
  }

  // Extrair dados da conta
  const { nome, cpf, banco, agencia, conta } = accountInfo;
  const { type, value } = pixInfo;

  // Validações dos campos obrigatórios
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });
  if (!cpf) return res.status(400).json({ error: 'CPF é obrigatório' });
  if (!banco) return res.status(400).json({ error: 'Banco é obrigatório' });
  if (!agencia) return res.status(400).json({ error: 'Agência é obrigatória' });
  if (!conta) return res.status(400).json({ error: 'Conta é obrigatória' });
  if (!type) return res.status(400).json({ error: 'Tipo de chave PIX é obrigatório' });
  if (!value) return res.status(400).json({ error: 'Valor da chave PIX é obrigatório' });

  // Validar formato do CPF da conta
  if (!validateCPF(cpf)) {
    return res.status(400).json({ error: 'CPF do titular é inválido. Deve ter 11 dígitos.' });
  }

  // Validar o valor da chave PIX de acordo com o tipo
  let isValidPix = false;
  switch (type) {
    case 'email':
      isValidPix = validateEmail(value);
      break;
    case 'phone':
      isValidPix = validatePhone(value);
      break;
    case 'cpf':
      isValidPix = validateCPF(value);
      break;
    case 'cnpj':
      isValidPix = validateCNPJ(value);
      break;
    case 'uuid':
      isValidPix = validateUUID(value);
      break;
    default:
      return res.status(400).json({ error: 'Tipo de chave PIX inválido. Use: email, phone, cpf, cnpj, uuid' });
  }

  if (!isValidPix) {
    return res.status(400).json({ error: `Valor da chave PIX (${type}) é inválido` });
  }

  // Inserir no banco de dados
  const sql = `
    INSERT INTO pix_records (pix_type, pix_value, nome, cpf, banco, agencia, conta) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [type, value, nome, cpf, banco, agencia, conta];

  db.run(sql, params, function (err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: `Chave PIX (${type}) já registrada` });
      }
      return res.status(500).json({ error: err.message });
    }

    res.status(201).json({
      id: this.lastID,
      accountInfo: { nome, cpf, banco, agencia, conta },
      pixInfo: { type, value },
      message: 'Registro criado com sucesso'
    });
  });
});

// Rota para excluir um registro por tipo e valor
app.delete('/record/:type/:value', (req, res) => {
  const { type, value } = req.params;

  // Validar o tipo de chave PIX
  const validTypes = ['email', 'phone', 'cpf', 'cnpj', 'uuid'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Tipo de chave PIX inválido' });
  }

  // Executar exclusão
  const sql = `DELETE FROM pix_records WHERE pix_type = ? AND pix_value = ?`;

  db.run(sql, [type, value], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    // Verificar se algum registro foi excluído
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Registro não encontrado' });
    }

    // Retornar sucesso
    res.json({
      message: 'Registro excluído com sucesso',
      deletedCount: this.changes
    });
  });
});

// Rota de status
app.get('/status', (req, res) => {
  res.json({ status: 'API funcionando', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
