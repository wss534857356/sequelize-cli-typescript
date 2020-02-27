'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.logMigrator = logMigrator;
exports.getMigrator = getMigrator;
exports.ensureCurrentMetaSchema = ensureCurrentMetaSchema;
exports.addTimestampsToSchema = addTimestampsToSchema;

var _umzug = require('umzug');

var _umzug2 = _interopRequireDefault(_umzug);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _fs = require('fs');

var _path = require('path');

var _typescript = require('typescript');

var _typescript2 = _interopRequireDefault(_typescript);

var _index = require('../helpers/index');

var _index2 = _interopRequireDefault(_index);

var _resolve = require('resolve');

var _resolve2 = _interopRequireDefault(_resolve);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const Sequelize = _index2.default.generic.getSequelize();

function logMigrator(s) {
  if (s.indexOf('Executing') !== 0) {
    _index2.default.view.log(s);
  }
}

function getSequelizeInstance() {
  let config = null;

  try {
    config = _index2.default.config.readConfig();
  } catch (e) {
    _index2.default.view.error(e);
  }

  config = _lodash2.default.defaults(config, { logging: logMigrator });

  try {
    return new Sequelize(config);
  } catch (e) {
    _index2.default.view.error(e);
  }
}

function getMigrator(type, args) {
  return _bluebird2.default.try(() => {
    if (!(_index2.default.config.configFileExists() || args.url)) {
      _index2.default.view.error('Cannot find "' + _index2.default.config.getConfigFile() + '". Have you run "sequelize init"?');
      process.exit(1);
    }

    let migratorPath = _index2.default.path.getPath(type);

    if (type === 'migration') {
      migratorPath = _index2.default.path.getMigrationsCompiledPath();
    }

    if (type === 'seeder') {
      migratorPath = _index2.default.path.getSeedersCompiledPath();
    }

    const sequelize = getSequelizeInstance();
    const migrator = new _umzug2.default({
      storage: _index2.default.umzug.getStorage(type),
      storageOptions: _index2.default.umzug.getStorageOptions(type, { sequelize }),
      logging: _index2.default.view.log,
      migrations: {
        params: [sequelize.getQueryInterface(), Sequelize],
        path: migratorPath,
        pattern: /\.[jt]s$/,
        customResolver: path => {
          const program = _typescript2.default.createProgram(path, {});
          const emitResult = program.emit();

          const allDiagnostics = _typescript2.default.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

          allDiagnostics.forEach(diagnostic => {
            if (diagnostic.file) {
              var _diagnostic$file$getL = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

              const line = _diagnostic$file$getL.line,
                    character = _diagnostic$file$getL.character;

              const message = _typescript2.default.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
              console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
            } else {
              console.log(_typescript2.default.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            }
          });
          const Module = module.constructor;
          const m = new Module(path, module.parent);
          m.filename = path;
          // eslint-disable-next-line no-undef
          m.paths = [...Module._nodeModulePaths((0, _path.dirname)(path)), (0, _resolve2.default)(__dirname, '../test/helpers'), (0, _resolve2.default)(__dirname, '../')];
          m._compile(emitResult, path);
          return m.exports;
        },
        wrap: fun => {
          if (fun.length === 3) {
            return _bluebird2.default.promisify(fun);
          } else {
            return fun;
          }
        }
      }
    });

    return sequelize.authenticate().then(() => {
      // Check if this is a PostgreSQL run and if there is a custom schema specified, and if there is, check if it's
      // been created. If not, attempt to create it.
      if (_index2.default.version.getDialectName() === 'pg') {
        const customSchemaName = _index2.default.umzug.getSchema('migration');
        if (customSchemaName && customSchemaName !== 'public') {
          return sequelize.createSchema(customSchemaName);
        }
      }

      return _bluebird2.default.resolve();
    }).then(() => migrator).catch(e => _index2.default.view.error(e));
  });
}

function ensureCurrentMetaSchema(migrator) {
  const queryInterface = migrator.options.storageOptions.sequelize.getQueryInterface();
  const tableName = migrator.options.storageOptions.tableName;
  const columnName = migrator.options.storageOptions.columnName;

  return ensureMetaTable(queryInterface, tableName).then(table => {
    const columns = Object.keys(table);

    if (columns.length === 1 && columns[0] === columnName) {
      return;
    } else if (columns.length === 3 && columns.indexOf('createdAt') >= 0) {
      return;
    }
  }).catch(() => {});
}

function ensureMetaTable(queryInterface, tableName) {
  return queryInterface.showAllTables().then(tableNames => {
    if (tableNames.indexOf(tableName) === -1) {
      throw new Error('No MetaTable table found.');
    }
    return queryInterface.describeTable(tableName);
  });
}

/**
 * Add timestamps
 *
 * @return {Promise}
 */
function addTimestampsToSchema(migrator) {
  const sequelize = migrator.options.storageOptions.sequelize;
  const queryInterface = sequelize.getQueryInterface();
  const tableName = migrator.options.storageOptions.tableName;

  return ensureMetaTable(queryInterface, tableName).then(table => {
    if (table.createdAt) {
      return;
    }

    return ensureCurrentMetaSchema(migrator).then(() => queryInterface.renameTable(tableName, tableName + 'Backup')).then(() => {
      const sql = queryInterface.QueryGenerator.selectQuery(tableName + 'Backup');
      return _index2.default.generic.execQuery(sequelize, sql, { type: 'SELECT', raw: true });
    }).then(result => {
      const SequelizeMeta = sequelize.define(tableName, {
        name: {
          type: Sequelize.STRING,
          allowNull: false,
          unique: true,
          primaryKey: true,
          autoIncrement: false
        }
      }, {
        tableName,
        timestamps: true,
        schema: _index2.default.umzug.getSchema()
      });

      return SequelizeMeta.sync().then(() => {
        return SequelizeMeta.bulkCreate(result);
      });
    });
  });
}